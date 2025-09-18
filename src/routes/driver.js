const express = require('express');
const { query } = require('../config/database');
const { authenticateToken, authorize } = require('../middleware/auth');
const { setWithExpiry, get } = require('../config/redis');

const router = express.Router();

// FEATURE 3: Driver Location Updates (Server-Sent Events Pattern)
// Pattern Choice: Server-Sent Events (SSE)
// Reasoning: One-way server-to-client updates, efficient, works over HTTP, handles mobile networks well

// Store SSE connections for active deliveries
const sseConnections = new Map(); // orderId -> Set of response objects

/**
 * PUT /api/driver/location
 * Driver updates their location (called every 10-15 seconds)
 */
router.put(
  '/location',
  authenticateToken,
  authorize(['driver']),
  async (req, res) => {
    try {
      const driverId = req.user.id;
      const { orderId, latitude, longitude } = req.body;

      if (!orderId || !latitude || !longitude) {
        return res.status(400).json({
          error: 'Order ID, latitude, and longitude are required',
        });
      }

      // Validate latitude and longitude ranges
      if (
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        return res.status(400).json({ error: 'Invalid coordinates' });
      }

      // Verify the driver is assigned to this order and order is in delivery phase
      const orderCheck = await query(
        `SELECT id, status, customer_id 
       FROM orders 
       WHERE id = $1 AND driver_id = $2 AND status IN ('picked_up', 'ready')`,
        [orderId, driverId]
      );

      if (orderCheck.rows.length === 0) {
        return res.status(403).json({
          error:
            'Order not found or not assigned to you, or not in delivery phase',
        });
      }

      const order = orderCheck.rows[0];

      // Update driver location in database (upsert)
      await query(
        `INSERT INTO driver_locations (driver_id, order_id, latitude, longitude, timestamp)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (driver_id, order_id)
       DO UPDATE SET 
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         timestamp = EXCLUDED.timestamp`,
        [driverId, orderId, latitude, longitude]
      );

      // Cache location for quick access
      const locationData = {
        driverId,
        orderId,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        timestamp: new Date().toISOString(),
        customerId: order.customer_id,
      };

      await setWithExpiry(`driver_location:${orderId}`, locationData, 300); // 5 min cache

      // Send location update via SSE to connected customers
      const connections = sseConnections.get(orderId);
      if (connections && connections.size > 0) {
        const sseData = {
          type: 'location_update',
          data: {
            latitude: locationData.latitude,
            longitude: locationData.longitude,
            timestamp: locationData.timestamp,
            orderId,
          },
        };

        // Send to all connected customers for this order
        connections.forEach((res) => {
          try {
            res.write(`data: ${JSON.stringify(sseData)}\n\n`);
          } catch (error) {
            console.error('Failed to send SSE update:', error);
            connections.delete(res);
          }
        });
      }

      res.json({
        message: 'Location updated successfully',
        timestamp: locationData.timestamp,
      });
    } catch (error) {
      console.error('Driver location update error:', error);
      res.status(500).json({ error: 'Failed to update location' });
    }
  }
);

/**
 * GET /api/driver/location/:orderId/stream
 * Server-Sent Events endpoint for real-time driver location
 * Customers connect to this to receive location updates
 */
router.get(
  '/location/:orderId/stream',
  authenticateToken,
  authorize(['customer']),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const customerId = req.user.id;

      // Verify customer owns this order and it's in delivery phase
      const orderCheck = await query(
        `SELECT id, status, driver_id 
       FROM orders 
       WHERE id = $1 AND customer_id = $2 AND status IN ('picked_up', 'ready') AND driver_id IS NOT NULL`,
        [orderId, customerId]
      );

      if (orderCheck.rows.length === 0) {
        return res.status(403).json({
          error: 'Order not found, not yours, or not in delivery phase',
        });
      }

      // Set SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control',
      });

      // Send initial connection confirmation
      res.write(
        `data: ${JSON.stringify({
          type: 'connection_established',
          data: { orderId, message: 'Connected to driver location updates' },
        })}\n\n`
      );

      // Send current location if available
      const currentLocation = await get(`driver_location:${orderId}`);
      if (currentLocation) {
        res.write(
          `data: ${JSON.stringify({
            type: 'location_update',
            data: {
              latitude: currentLocation.latitude,
              longitude: currentLocation.longitude,
              timestamp: currentLocation.timestamp,
              orderId,
            },
          })}\n\n`
        );
      }

      // Add this connection to the SSE connections map
      if (!sseConnections.has(orderId)) {
        sseConnections.set(orderId, new Set());
      }
      sseConnections.get(orderId).add(res);

      // Handle client disconnect
      req.on('close', () => {
        const connections = sseConnections.get(orderId);
        if (connections) {
          connections.delete(res);
          if (connections.size === 0) {
            sseConnections.delete(orderId);
          }
        }
        console.log(`SSE connection closed for order ${orderId}`);
      });

      // Send heartbeat every 30 seconds to keep connection alive
      const heartbeatInterval = setInterval(() => {
        try {
          res.write(
            `data: ${JSON.stringify({
              type: 'heartbeat',
              data: { timestamp: new Date().toISOString() },
            })}\n\n`
          );
        } catch (error) {
          clearInterval(heartbeatInterval);
          const connections = sseConnections.get(orderId);
          if (connections) {
            connections.delete(res);
          }
        }
      }, 30000);

      // Clean up interval when connection closes
      req.on('close', () => {
        clearInterval(heartbeatInterval);
      });
    } catch (error) {
      console.error('SSE connection error:', error);
      res.status(500).json({ error: 'Failed to establish location stream' });
    }
  }
);

/**
 * GET /api/driver/location/:orderId
 * Get current driver location (fallback for when SSE isn't available)
 */
router.get(
  '/location/:orderId',
  authenticateToken,
  authorize(['customer']),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const customerId = req.user.id;

      // Verify customer owns this order
      const orderCheck = await query(
        `SELECT id, status, driver_id 
       FROM orders 
       WHERE id = $1 AND customer_id = $2`,
        [orderId, customerId]
      );

      if (orderCheck.rows.length === 0) {
        return res
          .status(403)
          .json({ error: 'Order not found or access denied' });
      }

      const order = orderCheck.rows[0];

      if (!order.driver_id || !['picked_up', 'ready'].includes(order.status)) {
        return res.status(400).json({
          error: 'No driver assigned or order not in delivery phase',
        });
      }

      // Get current location from cache first
      let location = await get(`driver_location:${orderId}`);

      // If not in cache, get from database
      if (!location) {
        const locationResult = await query(
          `SELECT latitude, longitude, timestamp 
         FROM driver_locations 
         WHERE order_id = $1 AND driver_id = $2 
         ORDER BY timestamp DESC LIMIT 1`,
          [orderId, order.driver_id]
        );

        if (locationResult.rows.length > 0) {
          const dbLocation = locationResult.rows[0];
          location = {
            latitude: parseFloat(dbLocation.latitude),
            longitude: parseFloat(dbLocation.longitude),
            timestamp: dbLocation.timestamp,
          };

          // Cache it for future requests
          await setWithExpiry(`driver_location:${orderId}`, location, 300);
        }
      }

      if (!location) {
        return res
          .status(404)
          .json({ error: 'Driver location not available yet' });
      }

      // Check if location is recent (within 5 minutes)
      const locationAge = Date.now() - new Date(location.timestamp).getTime();
      const isStale = locationAge > 300000; // 5 minutes

      res.json({
        orderId,
        location: {
          latitude: location.latitude,
          longitude: location.longitude,
          timestamp: location.timestamp,
          isStale,
        },
        sse: {
          available: true,
          endpoint: `/api/driver/location/${orderId}/stream`,
          recommendation: 'Use SSE endpoint for real-time updates',
        },
      });
    } catch (error) {
      console.error('Driver location fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch driver location' });
    }
  }
);

/**
 * GET /api/driver/active-deliveries
 * Get active deliveries for current driver
 */
router.get(
  '/active-deliveries',
  authenticateToken,
  authorize(['driver']),
  async (req, res) => {
    try {
      const driverId = req.user.id;

      const result = await query(
        `SELECT o.id, o.status, o.delivery_address, o.total_amount, o.created_at,
              rest.name as restaurant_name, rest.address as restaurant_address,
              c.first_name || ' ' || c.last_name as customer_name
       FROM orders o
       JOIN restaurants rest ON o.restaurant_id = rest.id
       JOIN users r ON rest.user_id = r.id
       JOIN users c ON o.customer_id = c.id
       WHERE o.driver_id = $1 AND o.status IN ('picked_up', 'ready')
       ORDER BY o.created_at ASC`,
        [driverId]
      );

      const activeDeliveries = result.rows.map((order) => ({
        id: order.id,
        status: order.status,
        customerName: order.customer_name,
        restaurantName: order.restaurant_name,
        restaurantAddress: order.restaurant_address,
        deliveryAddress: order.delivery_address,
        totalAmount: order.total_amount,
        createdAt: order.created_at,
        locationUpdateEndpoint: '/api/driver/location',
      }));

      res.json({
        activeDeliveries,
        count: activeDeliveries.length,
        instructions: {
          locationUpdate:
            'POST to /api/driver/location every 10-15 seconds with orderId, latitude, longitude',
          statusUpdate:
            'PUT to /api/orders/{orderId}/status to update delivery status',
        },
      });
    } catch (error) {
      console.error('Active deliveries fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch active deliveries' });
    }
  }
);

/**
 * POST /api/driver/assign/:orderId
 * Driver self-assigns to an available order
 */
router.post(
  '/assign/:orderId',
  authenticateToken,
  authorize(['driver']),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const driverId = req.user.id;

      const result = await query(
        `UPDATE orders 
       SET driver_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND driver_id IS NULL AND status = 'ready'
       RETURNING id, status, delivery_address`,
        [driverId, orderId]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          error:
            'Order not available for assignment (already assigned or not ready)',
        });
      }

      const order = result.rows[0];

      res.json({
        message: 'Successfully assigned to order',
        orderId: order.id,
        deliveryAddress: order.delivery_address,
        nextSteps: [
          'Update status to "picked_up" when you collect the order',
          'Start sending location updates every 10-15 seconds',
          'Update status to "delivered" when delivery is complete',
        ],
      });
    } catch (error) {
      console.error('Driver assignment error:', error);
      res.status(500).json({ error: 'Failed to assign to order' });
    }
  }
);

/**
 * GET /api/driver/available-orders
 * Get all orders that don't have a driver assigned
 */
router.get(
  '/available-orders',
  authenticateToken,
  authorize(['driver']),
  async (req, res) => {
    try {
      const result = await query(
        `SELECT o.id, o.status, o.delivery_address, o.total_amount, o.created_at,
              rest.name as restaurant_name, rest.address as restaurant_address,
              c.first_name || ' ' || c.last_name as customer_name
       FROM orders o
       JOIN restaurants rest ON o.restaurant_id = rest.id
       JOIN users c ON o.customer_id = c.id
       WHERE o.driver_id IS NULL AND o.status = 'ready'
       ORDER BY o.created_at ASC`,
        []
      );

      const availableOrders = result.rows.map((order) => ({
        id: order.id,
        status: order.status,
        customerName: order.customer_name,
        restaurantName: order.restaurant_name,
        restaurantAddress: order.restaurant_address,
        deliveryAddress: order.delivery_address,
        totalAmount: order.total_amount,
        createdAt: order.created_at,
        assignEndpoint: `/api/driver/assign/${order.id}`,
      }));

      res.json({
        availableOrders,
        count: availableOrders.length,
        instructions: {
          assignment:
            'POST to /api/driver/assign/{orderId} to claim an order for delivery',
        },
      });
    } catch (error) {
      console.error('Available orders fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch available orders' });
    }
  }
);

module.exports = router;
