const express = require('express');
const { query, transaction } = require('../config/database');
const { authenticateToken, authorize } = require('../middleware/auth');

const router = express.Router();

// FEATURE 5: Customer Support Chat (WebSockets Pattern)
// Pattern Choice: WebSockets via Socket.io
// Reasoning: Bi-directional, instant messaging, typing indicators, real-time chat experience

/**
 * POST /api/support/chat/start
 * Start a new support chat session
 */
router.post(
  '/chat/start',
  authenticateToken,
  authorize(['customer']),
  async (req, res) => {
    try {
      const customerId = req.user.id;
      const { subject, initialMessage } = req.body;

      if (!subject || !initialMessage) {
        return res.status(400).json({
          error: 'Subject and initial message are required',
        });
      }

      const newChat = await transaction(async (client) => {
        // Create new chat
        const chatResult = await client.query(
          `INSERT INTO support_chats (customer_id, status)
         VALUES ($1, 'active')
         RETURNING id, customer_id, status, created_at`,
          [customerId]
        );

        const chat = chatResult.rows[0];

        // Add initial message
        await client.query(
          `INSERT INTO chat_messages (chat_id, sender_id, message, message_type)
         VALUES ($1, $2, $3, 'text')`,
          [chat.id, customerId, `Subject: ${subject}\n\n${initialMessage}`]
        );

        return chat;
      });

      res.status(201).json({
        message: 'Support chat started successfully',
        chatId: newChat.id,
        status: newChat.status,
        createdAt: newChat.created_at,
        websocket: {
          instruction: 'Connect to WebSocket and join chat room',
          event: 'join-support-chat',
          payload: { chatId: newChat.id },
        },
        estimatedWaitTime: '2-5 minutes',
      });
    } catch (error) {
      console.error('Support chat start error:', error);
      res.status(500).json({ error: 'Failed to start support chat' });
    }
  }
);

/**
 * GET /api/support/chat/:chatId/messages
 * Get chat message history
 */
router.get('/chat/:chatId/messages', authenticateToken, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;
    const userType = req.user.user_type;

    // Verify access to chat
    let accessQuery;
    if (userType === 'customer') {
      accessQuery =
        'SELECT id FROM support_chats WHERE id = $1 AND customer_id = $2';
    } else if (userType === 'support') {
      accessQuery =
        'SELECT id FROM support_chats WHERE id = $1 AND (agent_id = $2 OR agent_id IS NULL)';
    } else {
      return res.status(403).json({ error: 'Access denied' });
    }

    const chatCheck = await query(accessQuery, [chatId, userId]);
    if (chatCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Chat not found or access denied' });
    }

    // Get messages
    const messagesResult = await query(
      `SELECT cm.id, cm.sender_id, cm.message, cm.message_type, cm.is_read, cm.created_at,
              u.first_name || ' ' || u.last_name as sender_name,
              u.user_type as sender_type
       FROM chat_messages cm
       JOIN users u ON cm.sender_id = u.id
       WHERE cm.chat_id = $1
       ORDER BY cm.created_at ASC`,
      [chatId]
    );

    // Mark messages as read for current user
    await query(
      `UPDATE chat_messages 
       SET is_read = true 
       WHERE chat_id = $1 AND sender_id != $2`,
      [chatId, userId]
    );

    const messages = messagesResult.rows.map((msg) => ({
      id: msg.id,
      senderId: msg.sender_id,
      senderName: msg.sender_name,
      senderType: msg.sender_type,
      message: msg.message,
      messageType: msg.message_type,
      isRead: msg.is_read,
      createdAt: msg.created_at,
      isMine: msg.sender_id === userId,
    }));

    res.json({
      chatId,
      messages,
      totalMessages: messages.length,
      websocket: {
        instruction: 'Connect to WebSocket for real-time messages',
        room: `chat-${chatId}`,
      },
    });
  } catch (error) {
    console.error('Chat messages fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch chat messages' });
  }
});

/**
 * GET /api/support/chat/customer/active
 * Get customer's active chats
 */
router.get(
  '/chat/customer/active',
  authenticateToken,
  authorize(['customer']),
  async (req, res) => {
    try {
      const customerId = req.user.id;

      const chatsResult = await query(
        `SELECT sc.id, sc.status, sc.created_at, sc.updated_at,
              CASE 
                WHEN a.first_name IS NOT NULL 
                THEN a.first_name || ' ' || a.last_name 
                ELSE 'Unassigned' 
              END as agent_name,
              (
                SELECT cm.message 
                FROM chat_messages cm 
                WHERE cm.chat_id = sc.id 
                ORDER BY cm.created_at DESC 
                LIMIT 1
              ) as last_message,
              (
                SELECT COUNT(*) 
                FROM chat_messages cm 
                WHERE cm.chat_id = sc.id AND cm.sender_id != $1 AND cm.is_read = false
              ) as unread_count
       FROM support_chats sc
       LEFT JOIN users a ON sc.agent_id = a.id
       WHERE sc.customer_id = $1 AND sc.status IN ('active', 'waiting')
       ORDER BY sc.updated_at DESC`,
        [customerId]
      );

      const activeChats = chatsResult.rows.map((chat) => ({
        id: chat.id,
        status: chat.status,
        agentName: chat.agent_name,
        lastMessage: chat.last_message,
        unreadCount: parseInt(chat.unread_count),
        createdAt: chat.created_at,
        updatedAt: chat.updated_at,
      }));

      res.json({
        activeChats,
        count: activeChats.length,
        canStartNew: activeChats.length < 3, // Limit simultaneous chats
        websocket: {
          instruction: 'Connect to individual chat rooms for real-time updates',
        },
      });
    } catch (error) {
      console.error('Active chats fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch active chats' });
    }
  }
);

/**
 * GET /api/support/agent/queue
 * Get available chats for support agents
 */
router.get(
  '/agent/queue',
  authenticateToken,
  authorize(['support']),
  async (req, res) => {
    try {
      const agentId = req.user.id;

      // Get unassigned chats
      const queueResult = await query(
        `SELECT sc.id, sc.customer_id, sc.created_at,
              c.first_name || ' ' || c.last_name as customer_name,
              (
                SELECT cm.message 
                FROM chat_messages cm 
                WHERE cm.chat_id = sc.id 
                ORDER BY cm.created_at ASC 
                LIMIT 1
              ) as first_message,
              EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - sc.created_at))/60 as wait_time_minutes
       FROM support_chats sc
       JOIN users c ON sc.customer_id = c.id
       WHERE sc.agent_id IS NULL AND sc.status = 'active'
       ORDER BY sc.created_at ASC`,
        []
      );

      // Get agent's assigned chats
      const assignedResult = await query(
        `SELECT sc.id, sc.customer_id, sc.status, sc.created_at, sc.updated_at,
              c.first_name || ' ' || c.last_name as customer_name,
              (
                SELECT COUNT(*) 
                FROM chat_messages cm 
                WHERE cm.chat_id = sc.id AND cm.sender_id = sc.customer_id AND cm.is_read = false
              ) as unread_count
       FROM support_chats sc
       JOIN users c ON sc.customer_id = c.id
       WHERE sc.agent_id = $1 AND sc.status = 'active'
       ORDER BY sc.updated_at DESC`,
        [agentId]
      );

      const queuedChats = queueResult.rows.map((chat) => ({
        id: chat.id,
        customerId: chat.customer_id,
        customerName: chat.customer_name,
        firstMessage: chat.first_message,
        waitTimeMinutes: Math.floor(chat.wait_time_minutes),
        createdAt: chat.created_at,
      }));

      const assignedChats = assignedResult.rows.map((chat) => ({
        id: chat.id,
        customerId: chat.customer_id,
        customerName: chat.customer_name,
        status: chat.status,
        unreadCount: parseInt(chat.unread_count),
        createdAt: chat.created_at,
        updatedAt: chat.updated_at,
      }));

      res.json({
        queuedChats,
        assignedChats,
        queueCount: queuedChats.length,
        assignedCount: assignedChats.length,
        canTakeMore: assignedChats.length < 10, // Agent limit
        websocket: {
          instruction: 'Connect to agent room for new chat notifications',
          room: 'support-agents',
        },
      });
    } catch (error) {
      console.error('Support queue fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch support queue' });
    }
  }
);

/**
 * POST /api/support/agent/take/:chatId
 * Support agent takes a chat from queue
 */
router.post(
  '/agent/take/:chatId',
  authenticateToken,
  authorize(['support']),
  async (req, res) => {
    try {
      const { chatId } = req.params;
      const agentId = req.user.id;

      // Check if agent can take more chats
      const currentChatsResult = await query(
        'SELECT COUNT(*) as current_count FROM support_chats WHERE agent_id = $1 AND status = $2',
        [agentId, 'active']
      );

      const currentCount = parseInt(currentChatsResult.rows[0].current_count);
      if (currentCount >= 10) {
        return res.status(400).json({
          error: 'Maximum concurrent chats reached (10)',
        });
      }

      // Assign chat to agent
      const result = await query(
        `UPDATE support_chats 
       SET agent_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND agent_id IS NULL AND status = 'active'
       RETURNING id, customer_id`,
        [agentId, chatId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Chat not available or already assigned',
        });
      }

      const chat = result.rows[0];

      res.json({
        message: 'Chat assigned successfully',
        chatId: chat.id,
        customerId: chat.customer_id,
        agentId,
        websocket: {
          instruction: 'Join chat room for real-time communication',
          room: `chat-${chatId}`,
        },
      });
    } catch (error) {
      console.error('Chat assignment error:', error);
      res.status(500).json({ error: 'Failed to take chat' });
    }
  }
);

/**
 * PUT /api/support/chat/:chatId/close
 * Close a support chat
 */
router.put('/chat/:chatId/close', authenticateToken, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { resolution, rating } = req.body;
    const userId = req.user.id;
    const userType = req.user.user_type;

    // Verify access and close chat
    let updateQuery;
    if (userType === 'support') {
      updateQuery = `UPDATE support_chats SET status = 'resolved', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND agent_id = $2`;
    } else if (userType === 'customer') {
      updateQuery = `UPDATE support_chats SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND customer_id = $2`;
    } else {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await query(updateQuery, [chatId, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Chat not found or access denied' });
    }

    // Add closing message
    if (resolution) {
      await query(
        `INSERT INTO chat_messages (chat_id, sender_id, message, message_type)
         VALUES ($1, $2, $3, 'text')`,
        [chatId, userId, `Chat resolved: ${resolution}`]
      );
    }

    res.json({
      message: 'Chat closed successfully',
      chatId,
      status: userType === 'support' ? 'resolved' : 'closed',
      resolution,
      rating: rating ? parseInt(rating) : null,
    });
  } catch (error) {
    console.error('Chat close error:', error);
    res.status(500).json({ error: 'Failed to close chat' });
  }
});

module.exports = router;
