const express = require('express');
const { query, transaction } = require('../config/database');
const { authenticateToken, authorize } = require('../middleware/auth');
const { setWithExpiry, get } = require('../config/redis');

const router = express.Router();

// FEATURE 2: Order Tracking (Short Polling Pattern)
// Pattern Choice: HTTP polling every 60 seconds
// Reasoning: Battery efficient, handles poor networks well, slight delay acceptable

/**
 * POST /api/orders
 * Create a new order
 */
router.post(
  '/',
  authenticateToken,
  authorize(['customer']),
  async (req, res) => {
    try {
      const customerId = req.user.id;
      const { restaurantId, items, deliveryAddress, specialInstructions } =
        req.body;

      console.log('req.body:', req.body);
      if (
        !restaurantId ||
        !items ||
        !Array.isArray(items) ||
        items.length === 0
      ) {
        return res.status(400).json({
          error: 'Restaurant ID and items are required',
        });
      }

      if (!deliveryAddress) {
        return res.status(400).json({ error: 'Delivery address is required' });
      }

      const newOrder = await transaction(async (client) => {
        // Calculate total amount
        let totalAmount = 0;
        const validatedItems = [];

        for (const item of items) {
          const menuItemResult = await client.query(
            'SELECT id, price, name FROM menu_items WHERE id = $1 AND is_available = true',
            [item.menuItemId]
          );

          if (menuItemResult.rows.length === 0) {
            throw new Error(
              `Menu item ${item.menuItemId} not found or unavailable`
            );
          }

          const menuItem = menuItemResult.rows[0];
          const itemTotal = menuItem.price * item.quantity;
          totalAmount += itemTotal;

          validatedItems.push({
            menuItemId: menuItem.id,
            name: menuItem.name,
            quantity: item.quantity,
            pricePerItem: menuItem.price,
            itemTotal,
          });
        }

        // Create order
        const orderResult = await client.query(
          `INSERT INTO orders (customer_id, restaurant_id, total_amount, delivery_address, special_instructions, status)
         VALUES ($1, $2, $3, $4, $5, 'confirmed')
         RETURNING id, customer_id, restaurant_id, total_amount, delivery_address, special_instructions, status, created_at`,
          [
            customerId,
            restaurantId,
            totalAmount,
            deliveryAddress,
            specialInstructions,
          ]
        );

        const order = orderResult.rows[0];

        // Create order items
        for (const item of validatedItems) {
          await client.query(
            `INSERT INTO order_items (order_id, menu_item_id, quantity, price_per_item)
           VALUES ($1, $2, $3, $4)`,
            [order.id, item.menuItemId, item.quantity, item.pricePerItem]
          );
        }

        // Cache order status for polling
        await setWithExpiry(
          `order_status:${order.id}`,
          {
            orderId: order.id,
            status: order.status,
            lastUpdated: new Date().toISOString(),
            estimatedDelivery: new Date(
              Date.now() + 45 * 60 * 1000
            ).toISOString(), // 45 min estimate
          },
          3600
        ); // Cache for 1 hour

        return { ...order, items: validatedItems };
      });

      res.status(201).json({
        message: 'Order created successfully',
        order: newOrder,
      });
    } catch (error) {
      console.error('Order creation error:', error);
      res.status(500).json({
        error: 'Failed to create order',
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/orders/:orderId/status
 * Short polling endpoint for order status tracking
 * Clients should poll this every 60 seconds
 */

router.get('/:orderId/status', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;
    const userType = req.user.user_type;

    // First check Redis cache for quick response
    const cachedStatus = await get(`order_status:${orderId}`);
    let orderStatus;
    let fromCache = false;

    if (cachedStatus && cachedStatus.lastUpdated) {
      const cacheAge =
        Date.now() - new Date(cachedStatus.lastUpdated).getTime();

      // Use cache if it's less than 30 seconds old
      if (cacheAge < 30000) {
        orderStatus = cachedStatus;
        fromCache = true;
      }
    }

    // If not in cache or cache is stale, fetch from database
    if (!orderStatus) {
      const result = await query(
        `SELECT o.id, o.customer_id, o.restaurant_id, o.driver_id, o.status, 
                o.total_amount, o.delivery_address, o.created_at, o.updated_at,
                rest.name as restaurant_name,
                CASE 
                  WHEN d.first_name IS NOT NULL 
                  THEN d.first_name || ' ' || d.last_name 
                  ELSE NULL 
                END as driver_name
         FROM orders o
         LEFT JOIN restaurants rest ON o.restaurant_id = rest.id
         LEFT JOIN users r ON rest.user_id = r.id
         LEFT JOIN users d ON o.driver_id = d.id
         WHERE o.id = $1`,
        [orderId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = result.rows[0];

      // Authorization check
      if (userType === 'customer' && order.customer_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (userType === 'restaurant') {
        const restaurantCheck = await query(
          'SELECT id FROM restaurants WHERE user_id = $1 AND id = $2',
          [userId, order.restaurant_id]
        );
        if (restaurantCheck.rows.length === 0) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      // Calculate estimated delivery time based on status
      let estimatedDelivery = null;
      const orderTime = new Date(order.created_at);

      switch (order.status) {
        case 'confirmed':
          estimatedDelivery = new Date(orderTime.getTime() + 45 * 60 * 1000);
          break;
        case 'preparing':
          estimatedDelivery = new Date(orderTime.getTime() + 40 * 60 * 1000);
          break;
        case 'ready':
          estimatedDelivery = new Date(orderTime.getTime() + 25 * 60 * 1000);
          break;
        case 'picked_up':
          estimatedDelivery = new Date(orderTime.getTime() + 15 * 60 * 1000);
          break;
        case 'delivered':
          estimatedDelivery = order.updated_at;
          break;
      }

      orderStatus = {
        orderId: order.id,
        status: order.status,
        restaurantName: order.restaurant_name,
        driverName: order.driver_name,
        totalAmount: order.total_amount,
        deliveryAddress: order.delivery_address,
        estimatedDelivery: estimatedDelivery?.toISOString(),
        lastUpdated: new Date().toISOString(),
        createdAt: order.created_at,
        updatedAt: order.updated_at,
      };

      // Cache the result
      await setWithExpiry(`order_status:${orderId}`, orderStatus, 3600);
    }

    // Add polling instructions to response
    res.json({
      ...orderStatus,
      polling: {
        nextPollIn: 60, // seconds
        endpoint: `/api/orders/${orderId}/status`,
        fromCache,
      },
    });
  } catch (error) {
    console.error('Order status fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch order status' });
  }
});

/**
 * PUT /api/orders/:orderId/status
 * Update order status (restaurant/driver use)
 */
router.put('/:orderId/status', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;
    const userId = req.user.id;
    const userType = req.user.user_type;

    const validStatuses = [
      'confirmed',
      'preparing',
      'ready',
      'picked_up',
      'delivered',
      'cancelled',
    ];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status',
        validStatuses,
      });
    }

    // Authorization and status transition logic
    let updateQuery;
    let updateParams;

    if (userType === 'restaurant') {
      // Restaurants can update: confirmed -> preparing -> ready
      if (!['preparing', 'ready'].includes(status)) {
        return res.status(400).json({
          error: 'Restaurants can only set status to preparing or ready',
        });
      }

      updateQuery = `
        UPDATE orders 
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        FROM restaurants r
        WHERE orders.id = $2 AND orders.restaurant_id = r.id AND r.user_id = $3
        RETURNING orders.id, orders.status, orders.updated_at`;
      updateParams = [status, orderId, userId];
    } else if (userType === 'driver') {
      // Drivers can update: ready -> picked_up -> delivered
      if (!['picked_up', 'delivered'].includes(status)) {
        return res.status(400).json({
          error: 'Drivers can only set status to picked_up or delivered',
        });
      }

      updateQuery = `
        UPDATE orders 
        SET status = $1, driver_id = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3 AND (driver_id IS NULL OR driver_id = $2)
        RETURNING id, status, updated_at`;
      updateParams = [status, userId, orderId];
    } else {
      return res.status(403).json({
        error: 'Only restaurants and drivers can update order status',
      });
    }

    const result = await query(updateQuery, updateParams);

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: 'Order not found or access denied' });
    }

    const updatedOrder = result.rows[0];

    // Update cache
    const cachedStatus = await get(`order_status:${orderId}`);
    if (cachedStatus) {
      cachedStatus.status = updatedOrder.status;
      cachedStatus.lastUpdated = new Date().toISOString();
      await setWithExpiry(`order_status:${orderId}`, cachedStatus, 3600);
    }

    res.json({
      message: 'Order status updated successfully',
      orderId: updatedOrder.id,
      status: updatedOrder.status,
      updatedAt: updatedOrder.updated_at,
    });
  } catch (error) {
    console.error('Order status update error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

/**
 * GET /api/orders/customer/active
 * Get customer's active orders for polling
 */
router.get(
  '/customer/active',
  authenticateToken,
  authorize(['customer']),
  async (req, res) => {
    try {
      const customerId = req.user.id;

      const result = await query(
        `SELECT o.id, o.status, o.total_amount, o.created_at, rest.name as restaurant_name
       FROM orders o
       JOIN restaurants rest ON o.restaurant_id = rest.id
       JOIN users r ON rest.user_id = r.id
       WHERE o.customer_id = $1 AND o.status NOT IN ('delivered', 'cancelled')
       ORDER BY o.created_at DESC`,
        [customerId]
      );

      const activeOrders = result.rows.map((order) => ({
        id: order.id,
        status: order.status,
        restaurantName: order.restaurant_name,
        totalAmount: order.total_amount,
        createdAt: order.created_at,
        trackingUrl: `/api/orders/${order.id}/status`,
      }));

      res.json({
        activeOrders,
        count: activeOrders.length,
        polling: {
          recommendedInterval: 60, // seconds
          instruction: 'Poll individual order status endpoints',
        },
      });
    } catch (error) {
      console.error('Active orders fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch active orders' });
    }
  }
);

module.exports = router;
