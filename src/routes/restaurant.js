const express = require('express');
const { query } = require('../config/database');
const { authenticateToken, authorize } = require('../middleware/auth');

const router = express.Router();

// FEATURE 4: Restaurant Order Notifications (WebSockets Pattern)
// Pattern Choice: WebSockets via Socket.io
// Reasoning: Critical delivery (within 5 seconds), multiple staff, instant updates needed

/**
 * GET /api/restaurant/orders/pending
 * Get pending orders for restaurant
 */
router.get(
  '/orders/pending',
  authenticateToken,
  authorize(['restaurant']),
  async (req, res) => {
    try {
      const userId = req.user.id;

      // Get restaurant ID for this user
      const restaurantResult = await query(
        'SELECT id FROM restaurants WHERE user_id = $1',
        [userId]
      );

      if (restaurantResult.rows.length === 0) {
        return res.status(404).json({ error: 'Restaurant not found' });
      }

      const restaurantId = restaurantResult.rows[0].id;

      // Get pending orders
      const ordersResult = await query(
        `SELECT o.id, o.customer_id, o.total_amount, o.delivery_address, 
              o.special_instructions, o.status, o.created_at,
              c.first_name || ' ' || c.last_name as customer_name,
              c.phone as customer_phone,
              COALESCE(
                json_agg(
                  json_build_object(
                    'name', mi.name,
                    'quantity', oi.quantity,
                    'price_per_item', oi.price_per_item
                  )
                ) FILTER (WHERE mi.id IS NOT NULL), 
                '[]'
              ) as items
       FROM orders o
       JOIN users c ON o.customer_id = c.id
       LEFT JOIN order_items oi ON o.id = oi.order_id
       LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
       WHERE o.restaurant_id = $1 AND o.status IN ('confirmed', 'preparing')
       GROUP BY o.id, c.first_name, c.last_name, c.phone
       ORDER BY o.created_at ASC`,
        [restaurantId]
      );

      const pendingOrders = ordersResult.rows.map((order) => ({
        id: order.id,
        customerName: order.customer_name,
        customerPhone: order.customer_phone,
        totalAmount: order.total_amount,
        deliveryAddress: order.delivery_address,
        specialInstructions: order.special_instructions,
        status: order.status,
        items: order.items,
        createdAt: order.created_at,
        timeElapsed: Math.floor(
          (Date.now() - new Date(order.created_at).getTime()) / 1000
        ),
      }));

      res.json({
        pendingOrders,
        count: pendingOrders.length,
        restaurantId,
        websocket: {
          instruction:
            'Connect to WebSocket to receive real-time order notifications',
          event: 'join-restaurant',
          payload: { restaurantId },
        },
      });
    } catch (error) {
      console.error('Restaurant orders fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch restaurant orders' });
    }
  }
);

/**
 * PUT /api/restaurant/orders/:orderId/accept
 * Accept and start preparing an order
 */
router.put(
  '/orders/:orderId/accept',
  authenticateToken,
  authorize(['restaurant']),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const { estimatedPrepTime } = req.body; // in minutes
      const userId = req.user.id;

      // Verify restaurant owns this order
      const result = await query(
        `UPDATE orders 
       SET status = 'preparing', updated_at = CURRENT_TIMESTAMP
       FROM restaurants r
       WHERE orders.id = $1 AND orders.restaurant_id = r.id AND r.user_id = $2 AND orders.status = 'confirmed'
       RETURNING orders.id, orders.customer_id, orders.total_amount`,
        [orderId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Order not found, access denied, or already processed',
        });
      }

      const order = result.rows[0];

      // Emit status update via WebSocket (handled in socket handler)
      // The socket handler will emit to the customer

      res.json({
        message: 'Order accepted and preparation started',
        orderId: order.id,
        status: 'preparing',
        estimatedPrepTime: estimatedPrepTime || 25, // default 25 minutes
      });
    } catch (error) {
      console.error('Order accept error:', error);
      res.status(500).json({ error: 'Failed to accept order' });
    }
  }
);

/**
 * PUT /api/restaurant/orders/:orderId/ready
 * Mark order as ready for pickup
 */
router.put(
  '/orders/:orderId/ready',
  authenticateToken,
  authorize(['restaurant']),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const userId = req.user.id;

      // Verify restaurant owns this order and it's in preparing state
      const result = await query(
        `UPDATE orders 
       SET status = 'ready', updated_at = CURRENT_TIMESTAMP
       FROM restaurants r
       WHERE orders.id = $1 AND orders.restaurant_id = r.id AND r.user_id = $2 AND orders.status = 'preparing'
       RETURNING orders.id, orders.customer_id, orders.total_amount`,
        [orderId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Order not found, access denied, or not in preparing state',
        });
      }

      const order = result.rows[0];

      res.json({
        message: 'Order marked as ready for pickup',
        orderId: order.id,
        status: 'ready',
        instruction: 'Order is now available for driver pickup',
      });
    } catch (error) {
      console.error('Order ready error:', error);
      res.status(500).json({ error: 'Failed to mark order as ready' });
    }
  }
);

/**
 * PUT /api/restaurant/orders/:orderId/cancel
 * Cancel an order with reason
 */
router.put(
  '/orders/:orderId/cancel',
  authenticateToken,
  authorize(['restaurant']),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const { reason } = req.body;
      const userId = req.user.id;

      if (!reason) {
        return res
          .status(400)
          .json({ error: 'Cancellation reason is required' });
      }

      // Verify restaurant owns this order and it's not yet picked up
      const result = await query(
        `UPDATE orders 
       SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       FROM restaurants r
       WHERE orders.id = $1 AND orders.restaurant_id = r.id AND r.user_id = $2 
         AND orders.status IN ('confirmed', 'preparing', 'ready')
       RETURNING orders.id, orders.customer_id, orders.total_amount`,
        [orderId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error:
            'Order not found, access denied, or cannot be cancelled (already picked up/delivered)',
        });
      }

      const order = result.rows[0];

      res.json({
        message: 'Order cancelled successfully',
        orderId: order.id,
        status: 'cancelled',
        reason,
        instruction: 'Customer will be notified of cancellation',
      });
    } catch (error) {
      console.error('Order cancel error:', error);
      res.status(500).json({ error: 'Failed to cancel order' });
    }
  }
);

/**
 * GET /api/restaurant/dashboard
 * Restaurant dashboard data
 */
router.get(
  '/dashboard',
  authenticateToken,
  authorize(['restaurant']),
  async (req, res) => {
    try {
      const userId = req.user.id;

      // Get restaurant info
      const restaurantResult = await query(
        `SELECT r.id, r.name, r.cuisine_type, u.first_name || ' ' || u.last_name as owner_name
       FROM restaurants r
       JOIN users u ON r.user_id = u.id
       WHERE r.user_id = $1`,
        [userId]
      );

      if (restaurantResult.rows.length === 0) {
        return res.status(404).json({ error: 'Restaurant not found' });
      }

      const restaurant = restaurantResult.rows[0];

      // Get order statistics for today
      const today = new Date().toISOString().split('T')[0];
      const statsResult = await query(
        `SELECT 
         COUNT(*) FILTER (WHERE status = 'confirmed') as new_orders,
         COUNT(*) FILTER (WHERE status = 'preparing') as preparing_orders,
         COUNT(*) FILTER (WHERE status = 'ready') as ready_orders,
         COUNT(*) FILTER (WHERE status = 'delivered' AND DATE(created_at) = $2) as completed_today,
         COALESCE(SUM(total_amount) FILTER (WHERE status = 'delivered' AND DATE(created_at) = $2), 0) as revenue_today
       FROM orders 
       WHERE restaurant_id = $1`,
        [restaurant.id, today]
      );

      const stats = statsResult.rows[0];

      // Get recent orders
      const recentOrdersResult = await query(
        `SELECT o.id, o.status, o.total_amount, o.created_at,
              c.first_name || ' ' || c.last_name as customer_name
       FROM orders o
       JOIN users c ON o.customer_id = c.id
       WHERE o.restaurant_id = $1
       ORDER BY o.created_at DESC
       LIMIT 10`,
        [restaurant.id]
      );

      const recentOrders = recentOrdersResult.rows;

      res.json({
        restaurant: {
          id: restaurant.id,
          name: restaurant.name,
          cuisineType: restaurant.cuisine_type,
          ownerName: restaurant.owner_name,
        },
        statistics: {
          newOrders: parseInt(stats.new_orders),
          preparingOrders: parseInt(stats.preparing_orders),
          readyOrders: parseInt(stats.ready_orders),
          completedToday: parseInt(stats.completed_today),
          revenueToday: parseFloat(stats.revenue_today),
        },
        recentOrders: recentOrders.map((order) => ({
          id: order.id,
          status: order.status,
          customerName: order.customer_name,
          totalAmount: order.total_amount,
          createdAt: order.created_at,
        })),
        websocket: {
          instruction: 'Connect to WebSocket for real-time order notifications',
          events: ['new-order', 'order-update'],
          room: `restaurant-${restaurant.id}`,
        },
      });
    } catch (error) {
      console.error('Restaurant dashboard error:', error);
      res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
  }
);

module.exports = router;
