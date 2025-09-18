const { query } = require('../config/database');

// FEATURE 5: Customer Support Chat Socket Handler
// WebSocket implementation for real-time chat functionality

/**
 * Handle chat-specific WebSocket events
 */
function chatHandler(io, socket) {
  // Join a specific support chat room
  socket.on('join-support-chat', async (data) => {
    try {
      const { chatId, token } = data;

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

      // Get user details
      const userResult = await query(
        'SELECT id, user_type, first_name, last_name FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        socket.emit('error', { message: 'User not found' });
        return;
      }

      const user = userResult.rows[0];

      // Verify access to chat
      let chatCheck;
      if (user.user_type === 'customer') {
        chatCheck = await query(
          'SELECT id, status, agent_id FROM support_chats WHERE id = $1 AND customer_id = $2',
          [chatId, userId]
        );
      } else if (user.user_type === 'support') {
        chatCheck = await query(
          'SELECT id, status, customer_id FROM support_chats WHERE id = $1 AND (agent_id = $2 OR agent_id IS NULL)',
          [chatId, userId]
        );
      } else {
        socket.emit('error', { message: 'Access denied' });
        return;
      }

      if (chatCheck.rows.length === 0) {
        socket.emit('error', { message: 'Chat not found or access denied' });
        return;
      }

      const chat = chatCheck.rows[0];
      const roomName = `chat-${chatId}`;

      // Store user info in socket
      socket.userId = userId;
      socket.userType = user.user_type;
      socket.userName = `${user.first_name} ${user.last_name}`;
      socket.chatId = chatId;

      // Join chat room
      socket.join(roomName);

      socket.emit('joined-chat', {
        chatId,
        room: roomName,
        userType: user.user_type,
        userName: socket.userName,
        chatStatus: chat.status,
        message: 'Connected to support chat',
      });

      // Notify other participants that user joined
      socket.to(roomName).emit('user-joined-chat', {
        userId,
        userName: socket.userName,
        userType: user.user_type,
        timestamp: new Date().toISOString(),
      });

      console.log(`User ${userId} (${user.user_type}) joined chat ${chatId}`);
    } catch (error) {
      console.error('Join chat error:', error);
      socket.emit('error', { message: 'Failed to join chat' });
    }
  });

  // Send a message in chat
  socket.on('send-message', async (data) => {
    try {
      const { message, messageType = 'text' } = data;

      if (!socket.chatId || !socket.userId) {
        socket.emit('error', { message: 'Not connected to any chat' });
        return;
      }

      if (!message || message.trim().length === 0) {
        socket.emit('error', { message: 'Message cannot be empty' });
        return;
      }

      if (message.length > 1000) {
        socket.emit('error', {
          message: 'Message too long (max 1000 characters)',
        });
        return;
      }

      // Save message to database
      const result = await query(
        `INSERT INTO chat_messages (chat_id, sender_id, message, message_type)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at`,
        [socket.chatId, socket.userId, message.trim(), messageType]
      );

      const newMessage = result.rows[0];

      // Update chat updated_at timestamp
      await query(
        'UPDATE support_chats SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [socket.chatId]
      );

      // Prepare message data for broadcast
      const messageData = {
        id: newMessage.id,
        chatId: socket.chatId,
        senderId: socket.userId,
        senderName: socket.userName,
        senderType: socket.userType,
        message: message.trim(),
        messageType,
        createdAt: newMessage.created_at,
        timestamp: new Date().toISOString(),
      };

      // Broadcast to all users in the chat room
      io.to(`chat-${socket.chatId}`).emit('new-message', messageData);

      // Send delivery confirmation to sender
      socket.emit('message-sent', {
        tempId: data.tempId, // Client can track message with temp ID
        messageId: newMessage.id,
        timestamp: messageData.timestamp,
      });
    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Handle typing indicators
  socket.on('typing-start', () => {
    if (socket.chatId) {
      socket.to(`chat-${socket.chatId}`).emit('user-typing', {
        userId: socket.userId,
        userName: socket.userName,
        userType: socket.userType,
        isTyping: true,
      });
    }
  });

  socket.on('typing-stop', () => {
    if (socket.chatId) {
      socket.to(`chat-${socket.chatId}`).emit('user-typing', {
        userId: socket.userId,
        userName: socket.userName,
        userType: socket.userType,
        isTyping: false,
      });
    }
  });

  // Mark messages as read
  socket.on('mark-messages-read', async (data) => {
    try {
      const { upToMessageId } = data;

      if (!socket.chatId || !socket.userId) {
        return;
      }

      // Mark messages as read up to specified message ID
      await query(
        `UPDATE chat_messages 
         SET is_read = true 
         WHERE chat_id = $1 AND sender_id != $2 AND id <= $3`,
        [socket.chatId, socket.userId, upToMessageId]
      );

      // Notify other participants
      socket.to(`chat-${socket.chatId}`).emit('messages-read', {
        readBy: socket.userId,
        readByName: socket.userName,
        upToMessageId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Mark messages read error:', error);
    }
  });

  // Transfer chat to another agent (support agents only)
  socket.on('transfer-chat', async (data) => {
    try {
      const { toAgentId, reason } = data;

      if (socket.userType !== 'support' || !socket.chatId) {
        socket.emit('error', {
          message: 'Only support agents can transfer chats',
        });
        return;
      }

      // Verify target agent exists and is available
      const targetAgent = await query(
        `SELECT id, first_name, last_name FROM users 
         WHERE id = $1 AND user_type = 'support' AND is_active = true`,
        [toAgentId]
      );

      if (targetAgent.rows.length === 0) {
        socket.emit('error', {
          message: 'Target agent not found or unavailable',
        });
        return;
      }

      // Check if target agent has capacity
      const targetAgentChats = await query(
        'SELECT COUNT(*) as count FROM support_chats WHERE agent_id = $1 AND status = $2',
        [toAgentId, 'active']
      );

      if (parseInt(targetAgentChats.rows[0].count) >= 10) {
        socket.emit('error', {
          message: 'Target agent has reached maximum chat capacity',
        });
        return;
      }

      // Transfer the chat
      await query(
        'UPDATE support_chats SET agent_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [toAgentId, socket.chatId]
      );

      // Add transfer message
      await query(
        `INSERT INTO chat_messages (chat_id, sender_id, message, message_type)
         VALUES ($1, $2, $3, 'text')`,
        [
          socket.chatId,
          socket.userId,
          `Chat transferred to ${targetAgent.rows[0].first_name} ${
            targetAgent.rows[0].last_name
          }. Reason: ${reason || 'No reason specified'}`,
        ]
      );

      // Notify all participants
      io.to(`chat-${socket.chatId}`).emit('chat-transferred', {
        fromAgent: socket.userName,
        toAgent: `${targetAgent.rows[0].first_name} ${targetAgent.rows[0].last_name}`,
        reason,
        timestamp: new Date().toISOString(),
      });

      socket.emit('transfer-successful', {
        message: 'Chat transferred successfully',
      });
    } catch (error) {
      console.error('Chat transfer error:', error);
      socket.emit('error', { message: 'Failed to transfer chat' });
    }
  });

  // Leave chat room
  socket.on('leave-chat', () => {
    if (socket.chatId) {
      const roomName = `chat-${socket.chatId}`;
      socket.to(roomName).emit('user-left-chat', {
        userId: socket.userId,
        userName: socket.userName,
        userType: socket.userType,
        timestamp: new Date().toISOString(),
      });
      socket.leave(roomName);
      console.log(`User ${socket.userId} left chat ${socket.chatId}`);
      socket.chatId = null;
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    if (socket.chatId) {
      socket.to(`chat-${socket.chatId}`).emit('user-left-chat', {
        userId: socket.userId,
        userName: socket.userName,
        userType: socket.userType,
        timestamp: new Date().toISOString(),
        reason: 'disconnected',
      });
      console.log(
        `User ${socket.userId} disconnected from chat ${socket.chatId}`
      );
    }
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

module.exports = { chatHandler };
