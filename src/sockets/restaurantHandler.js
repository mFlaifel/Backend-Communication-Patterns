const { query } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// FEATURE 4: Restaurant Order Notifications Socket Handler
// WebSocket implementation for instant order delivery to restaurants

/**
 * Handle restaurant-specific WebSocket events
 */
function restaurantHandler(io, socket) {
  // Restaurant staff joins their restaurant room for order notifications
  socket.on('join-restaurant', async (data) => {
    try {
      const { restaurantId, token } = data;

      if (!token) {
        socket.emit('error', { message: 'Authentication token required' });
        return;
      }

      // Verify token and restaurant access
      // Note: In production, you'd want to properly verify JWT here
      const userId = await verifyTokenAndGetUserId(token);

      if (!userId) {
        socket.emit('error', { message: 'Invalid authentication token' });
        return;
      }

      // Verify user has access to this restaurant
      const restaurantCheck = await query(
        'SELECT id, name FROM restaurants WHERE id = $1 AND user_id = $2',
        [restaurantId, userId]
      );

      if (restaurantCheck.rows.length === 0) {
        socket.emit('error', { message: 'Access denied to restaurant' });
        return;
      }

      const restaurant = restaurantCheck.rows[0];
      const roomName = `restaurant-${restaurantId}`;

      // Join restaurant room
      socket.join(roomName);
      socket.restaurantId = restaurantId;
      socket.userId = userId;

      socket.emit('joined-restaurant', {
        restaurantId,
        restaurantName: restaurant.name,
        room: roomName,
        message: 'Connected to restaurant notifications',
      });

      console.log(`Restaurant staff ${userId} joined room ${roomName}`);
    } catch (error) {
      console.error('Join restaurant error:', error);
      socket.emit('error', { message: 'Failed to join restaurant' });
    }
  });

  // Leave restaurant room
  socket.on('leave-restaurant', () => {
    if (socket.restaurantId) {
      const roomName = `restaurant-${socket.restaurantId}`;
      socket.leave(roomName);
      console.log(`Restaurant staff left room ${roomName}`);
    }
  });

  // Handle order status updates from restaurant staff
  socket.on('update-order-status', async (data) => {
    try {
      const { orderId, status, estimatedTime } = data;

      if (!socket.restaurantId || !socket.userId) {
        socket.emit('error', {
          message: 'Not authenticated or not in restaurant room',
        });
        return;
      }

      const validStatuses = ['preparing', 'ready', 'cancelled'];
      if (!validStatuses.includes(status)) {
        socket.emit('error', {
          message: 'Invalid status',
          validStatuses,
        });
        return;
      }

      // Update order status in database
      const result = await query(
        `UPDATE orders 
         SET status = $1, updated_at = CURRENT_TIMESTAMP
         FROM restaurants r
         WHERE orders.id = $2 AND orders.restaurant_id = r.id AND r.user_id = $3
         RETURNING orders.id, orders.customer_id, orders.status, orders.total_amount`,
        [status, orderId, socket.userId]
      );

      if (result.rows.length === 0) {
        socket.emit('error', {
          message: 'Order not found or access denied',
        });
        return;
      }

      const order = result.rows[0];

      // Emit to all restaurant staff in the room
      io.to(`restaurant-${socket.restaurantId}`).emit('order-status-updated', {
        orderId: order.id,
        status: order.status,
        updatedBy: socket.userId,
        timestamp: new Date().toISOString(),
        estimatedTime,
      });

      // Notify customer of status change
      io.to(`customer-${order.customer_id}`).emit('order-status-update', {
        orderId: order.id,
        status: order.status,
        message: getStatusMessage(order.status),
        estimatedTime,
        timestamp: new Date().toISOString(),
      });

      socket.emit('status-update-confirmed', {
        orderId,
        status,
        message: 'Order status updated successfully',
      });
    } catch (error) {
      console.error('Order status update error:', error);
      socket.emit('error', { message: 'Failed to update order status' });
    }
  });

  // Get restaurant statistics in real-time
  socket.on('get-restaurant-stats', async () => {
    try {
      if (!socket.restaurantId) {
        socket.emit('error', { message: 'Not in restaurant room' });
        return;
      }

      const today = new Date().toISOString().split('T')[0];
      const statsResult = await query(
        `SELECT 
           COUNT(*) FILTER (WHERE status = 'confirmed') as new_orders,
           COUNT(*) FILTER (WHERE status = 'preparing') as preparing_orders,
           COUNT(*) FILTER (WHERE status = 'ready') as ready_orders,
           COUNT(*) FILTER (WHERE status = 'delivered' AND DATE(created_at) = $2) as completed_today,
           COALESCE(SUM(total_amount) FILTER (WHERE status = 'delivered' AND DATE(created_at) = $2), 0) as revenue_today,
           AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/60) FILTER (WHERE status = 'ready') as avg_prep_time
         FROM orders 
         WHERE restaurant_id = $1`,
        [socket.restaurantId, today]
      );

      const stats = statsResult.rows[0];

      socket.emit('restaurant-stats', {
        newOrders: parseInt(stats.new_orders),
        preparingOrders: parseInt(stats.preparing_orders),
        readyOrders: parseInt(stats.ready_orders),
        completedToday: parseInt(stats.completed_today),
        revenueToday: parseFloat(stats.revenue_today),
        avgPrepTime: parseFloat(stats.avg_prep_time) || 0,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Restaurant stats error:', error);
      socket.emit('error', { message: 'Failed to fetch restaurant stats' });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    if (socket.restaurantId) {
      console.log(
        `Restaurant staff disconnected from restaurant-${socket.restaurantId}`
      );
    }
  });
}

// Helper function to verify JWT token (simplified for demo)
async function verifyTokenAndGetUserId(token) {
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.userId;
  } catch (error) {
    return null;
  }
}

// Helper function to get user-friendly status messages
function getStatusMessage(status) {
  const messages = {
    confirmed: 'Your order has been confirmed and sent to the restaurant.',
    preparing: 'The restaurant is preparing your order.',
    ready: 'Your order is ready for pickup! A driver will collect it soon.',
    picked_up: 'Your order has been picked up and is on the way!',
    delivered: 'Your order has been delivered. Enjoy your meal!',
    cancelled: 'Your order has been cancelled. You will be refunded.',
  };
  return messages[status] || 'Order status updated.';
}

// Function to emit new order to restaurant (called from order creation)
async function notifyRestaurantNewOrder(io, restaurantId, orderData) {
  try {
    const roomName = `restaurant-${restaurantId}`;

    // Get detailed order information
    const orderResult = await query(
      `SELECT o.id, o.customer_id, o.total_amount, o.delivery_address, 
              o.special_instructions, o.status, o.created_at,
              c.first_name || ' ' || c.last_name as customer_name,
              c.phone as customer_phone,
              json_agg(
                json_build_object(
                  'name', mi.name,
                  'quantity', oi.quantity,
                  'price_per_item', oi.price_per_item,
                  'total', oi.quantity * oi.price_per_item
                )
              ) as items
       FROM orders o
       JOIN users c ON o.customer_id = c.id
       JOIN order_items oi ON o.id = oi.order_id
       JOIN menu_items mi ON oi.menu_item_id = mi.id
       WHERE o.id = $1
       GROUP BY o.id, c.first_name, c.last_name, c.phone`,
      [orderData.id || orderData.orderId]
    );

    if (orderResult.rows.length === 0) {
      console.error('Order not found for notification:', orderData.id);
      return;
    }

    const order = orderResult.rows[0];

    // Emit to all restaurant staff in the room
    io.to(roomName).emit('new-order', {
      orderId: order.id,
      customerName: order.customer_name,
      customerPhone: order.customer_phone,
      totalAmount: order.total_amount,
      deliveryAddress: order.delivery_address,
      specialInstructions: order.special_instructions,
      items: order.items,
      createdAt: order.created_at,
      status: order.status,
      urgency: 'high', // New orders are high priority
      sound: true, // Tell client to play notification sound
      message: `New order #${order.id} from ${order.customer_name}`,
    });

    console.log(`New order notification sent to restaurant ${restaurantId}`);
  } catch (error) {
    console.error('Error notifying restaurant of new order:', error);
  }
}

module.exports = {
  restaurantHandler,
  notifyRestaurantNewOrder,
};
