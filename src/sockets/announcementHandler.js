const { subscribe } = require('../config/redis');

// FEATURE 6: System-Wide Announcements Socket Handler
// Pub/Sub pattern implementation for broadcasting announcements

/**
 * Handle announcement-specific WebSocket events
 */
function announcementHandler(io, socket) {
  // User subscribes to announcements based on their user type
  socket.on('subscribe-announcements', async (data) => {
    try {
      const { userType, token } = data;

      if (!token) {
        socket.emit('error', { message: 'Authentication token required' });
        return;
      }

      // Verify token and get user info
      const userId = await verifyTokenAndGetUserId(token);
      if (!userId) {
        socket.emit('error', { message: 'Invalid authentication token' });
        return;
      }

      const validUserTypes = ['customer', 'restaurant', 'driver', 'support'];
      if (!validUserTypes.includes(userType)) {
        socket.emit('error', {
          message: 'Invalid user type',
          validTypes: validUserTypes,
        });
        return;
      }

      // Join announcement room based on user type
      const roomName = `announcements-${userType}`;
      socket.join(roomName);
      socket.join('announcements-all'); // All users get general announcements

      socket.userType = userType;
      socket.userId = userId;

      socket.emit('subscribed-announcements', {
        userType,
        rooms: [roomName, 'announcements-all'],
        message: 'Subscribed to announcements successfully',
      });

      console.log(`User ${userId} (${userType}) subscribed to announcements`);
    } catch (error) {
      console.error('Subscribe announcements error:', error);
      socket.emit('error', { message: 'Failed to subscribe to announcements' });
    }
  });

  // Unsubscribe from announcements
  socket.on('unsubscribe-announcements', () => {
    if (socket.userType) {
      socket.leave(`announcements-${socket.userType}`);
      socket.leave('announcements-all');

      socket.emit('unsubscribed-announcements', {
        message: 'Unsubscribed from announcements',
      });

      console.log(`User ${socket.userId} unsubscribed from announcements`);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    if (socket.userType && socket.userId) {
      console.log(
        `User ${socket.userId} (${socket.userType}) disconnected from announcements`
      );
    }
  });
}

// Initialize Redis subscribers for different user types
function initializeAnnouncementSubscribers(io) {
  const userTypes = ['all', 'customers', 'restaurants', 'drivers'];

  userTypes.forEach((userType) => {
    const channel = `announcements-${userType}`;

    subscribe(channel, (announcementData) => {
      try {
        // Determine which socket room to broadcast to
        const roomName = `announcements-${userType}`;

        // Broadcast to all connected users of this type
        io.to(roomName).emit('new-announcement', {
          id: announcementData.id,
          title: announcementData.title,
          message: announcementData.message,
          type: announcementData.type,
          priority: announcementData.priority,
          timestamp: announcementData.timestamp,
          expiresAt: announcementData.expiresAt,
          // UI hints
          displayDuration: getDisplayDuration(announcementData.type),
          showNotification: shouldShowNotification(announcementData.type),
          playSound: announcementData.type === 'urgent',
        });

        console.log(
          `Broadcast announcement "${announcementData.title}" to ${roomName}`
        );
      } catch (error) {
        console.error(`Error broadcasting to ${channel}:`, error);
      }
    });

    console.log(`Subscribed to Redis channel: ${channel}`);
  });
}

// Helper function to verify JWT token
async function verifyTokenAndGetUserId(token) {
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.userId;
  } catch (error) {
    console.error('Token verification error:', error);
    return null;
  }
}

// Helper function to determine display duration based on announcement type
function getDisplayDuration(type) {
  const durations = {
    urgent: 30000, // 30 seconds
    maintenance: 20000, // 20 seconds
    promotion: 15000, // 15 seconds
    general: 10000, // 10 seconds
  };
  return durations[type] || 10000;
}

// Helper function to determine if notification should be shown
function shouldShowNotification(type) {
  const notificationTypes = ['urgent', 'maintenance'];
  return notificationTypes.includes(type);
}

module.exports = {
  announcementHandler,
  initializeAnnouncementSubscribers,
};
