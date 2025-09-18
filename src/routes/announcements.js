const express = require('express');
const { query } = require('../config/database');
const { authenticateToken, authorize } = require('../middleware/auth');
const { publish } = require('../config/redis');

const router = express.Router();

// FEATURE 6: System-Wide Announcements (Pub/Sub Pattern)
// Pattern Choice: Redis Pub/Sub with WebSocket delivery
// Reasoning: Efficient broadcasting to thousands of users, not critical timing, scales well

/**
 * POST /api/announcements
 * Create and broadcast a system-wide announcement (admin only)
 */
router.post(
  '/',
  authenticateToken,
  authorize(['support']),
  async (req, res) => {
    try {
      const {
        title,
        message,
        announcementType,
        targetAudience,
        scheduledAt,
        expiresAt,
      } = req.body;

      if (!title || !message) {
        return res.status(400).json({
          error: 'Title and message are required',
        });
      }

      const validTypes = ['general', 'maintenance', 'promotion', 'urgent'];
      const validAudiences = ['all', 'customers', 'restaurants', 'drivers'];

      if (announcementType && !validTypes.includes(announcementType)) {
        return res.status(400).json({
          error: 'Invalid announcement type',
          validTypes,
        });
      }

      if (targetAudience && !validAudiences.includes(targetAudience)) {
        return res.status(400).json({
          error: 'Invalid target audience',
          validAudiences,
        });
      }

      // Create announcement in database
      const result = await query(
        `INSERT INTO announcements (title, message, announcement_type, target_audience, scheduled_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, message, announcement_type, target_audience, scheduled_at, expires_at, created_at`,
        [
          title,
          message,
          announcementType || 'general',
          targetAudience || 'all',
          scheduledAt ? new Date(scheduledAt) : null,
          expiresAt ? new Date(expiresAt) : null,
        ]
      );

      const announcement = result.rows[0];

      // If not scheduled for later, broadcast immediately
      if (!scheduledAt || new Date(scheduledAt) <= new Date()) {
        await broadcastAnnouncement(announcement);
      }

      res.status(201).json({
        message: 'Announcement created successfully',
        announcement: {
          id: announcement.id,
          title: announcement.title,
          message: announcement.message,
          type: announcement.announcement_type,
          targetAudience: announcement.target_audience,
          scheduledAt: announcement.scheduled_at,
          expiresAt: announcement.expires_at,
          createdAt: announcement.created_at,
        },
        broadcast: scheduledAt ? 'scheduled' : 'immediate',
      });
    } catch (error) {
      console.error('Announcement creation error:', error);
      res.status(500).json({ error: 'Failed to create announcement' });
    }
  }
);

/**
 * GET /api/announcements/active
 * Get active announcements for current user
 */
router.get('/active', authenticateToken, async (req, res) => {
  try {
    const userType = req.user.user_type;

    // Get active announcements for user type
    const result = await query(
      `SELECT id, title, message, announcement_type, target_audience, created_at, expires_at
       FROM announcements 
       WHERE is_active = true 
         AND (target_audience = 'all' OR target_audience = $1)
         AND (scheduled_at IS NULL OR scheduled_at <= CURRENT_TIMESTAMP)
         AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
       ORDER BY 
         CASE announcement_type 
           WHEN 'urgent' THEN 1
           WHEN 'maintenance' THEN 2
           WHEN 'promotion' THEN 3
           ELSE 4
         END,
         created_at DESC`,
      [userType]
    );

    const announcements = result.rows.map((announcement) => ({
      id: announcement.id,
      title: announcement.title,
      message: announcement.message,
      type: announcement.announcement_type,
      targetAudience: announcement.target_audience,
      createdAt: announcement.created_at,
      expiresAt: announcement.expires_at,
      priority: getPriorityLevel(announcement.announcement_type),
    }));

    res.json({
      announcements,
      count: announcements.length,
      userType,
      websocket: {
        instruction: 'Connect to WebSocket to receive real-time announcements',
        channel: `announcements-${userType}`,
      },
    });
  } catch (error) {
    console.error('Active announcements fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

/**
 * PUT /api/announcements/:id/dismiss
 * Mark announcement as dismissed for user (optional feature)
 */
router.put('/:id/dismiss', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // In a full implementation, you might track dismissals per user
    // For now, we'll just acknowledge the dismissal

    res.json({
      message: 'Announcement dismissed',
      announcementId: id,
      userId,
      instruction: 'Announcement hidden on client side',
    });
  } catch (error) {
    console.error('Announcement dismiss error:', error);
    res.status(500).json({ error: 'Failed to dismiss announcement' });
  }
});

/**
 * GET /api/announcements (admin only)
 * Get all announcements for management
 */
router.get('/', authenticateToken, authorize(['support']), async (req, res) => {
  try {
    const { page = 1, limit = 20, type, audience, active } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (type) {
      whereClause += ` AND announcement_type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (audience) {
      whereClause += ` AND target_audience = $${paramIndex}`;
      params.push(audience);
      paramIndex++;
    }

    if (active !== undefined) {
      whereClause += ` AND is_active = $${paramIndex}`;
      params.push(active === 'true');
      paramIndex++;
    }

    const offset = (page - 1) * limit;

    // Add limit and offset parameters
    const limitIndex = paramIndex;
    params.push(parseInt(limit));
    paramIndex++;

    const offsetIndex = paramIndex;
    params.push(offset);

    const result = await query(
      `SELECT id, title, message, announcement_type, target_audience, 
              is_active, scheduled_at, expires_at, created_at
       FROM announcements 
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params
    );

    // Get total count - create a copy of params without limit and offset
    const countParams = params.slice(0, limitIndex - 1);

    const countResult = await query(
      `SELECT COUNT(*) as total FROM announcements ${whereClause}`,
      countParams
    );

    const totalCount = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      announcements: result.rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (error) {
    console.error('Announcements fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

/**
 * DELETE /api/announcements/:id
 * Delete/deactivate announcement (admin only)
 */
router.delete(
  '/:id',
  authenticateToken,
  authorize(['support']),
  async (req, res) => {
    try {
      const { id } = req.params;

      const result = await query(
        'UPDATE announcements SET is_active = false WHERE id = $1 RETURNING id, title',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Announcement not found' });
      }

      const announcement = result.rows[0];

      res.json({
        message: 'Announcement deactivated successfully',
        announcementId: announcement.id,
        title: announcement.title,
      });
    } catch (error) {
      console.error('Announcement deletion error:', error);
      res.status(500).json({ error: 'Failed to delete announcement' });
    }
  }
);

// Helper function to broadcast announcement via Redis Pub/Sub
async function broadcastAnnouncement(announcement) {
  try {
    const announcementData = {
      id: announcement.id,
      title: announcement.title,
      message: announcement.message,
      type: announcement.announcement_type,
      targetAudience: announcement.target_audience,
      priority: getPriorityLevel(announcement.announcement_type),
      timestamp: new Date().toISOString(),
      expiresAt: announcement.expires_at,
    };

    // Publish to different channels based on target audience
    if (announcement.target_audience === 'all') {
      await publish('announcements-all', announcementData);
      await publish('announcements-customers', announcementData);
      await publish('announcements-restaurants', announcementData);
      await publish('announcements-drivers', announcementData);
    } else {
      await publish(
        `announcements-${announcement.target_audience}`,
        announcementData
      );
    }

    console.log(
      `Announcement broadcast: ${announcement.title} to ${announcement.target_audience}`
    );
  } catch (error) {
    console.error('Announcement broadcast error:', error);
    throw error;
  }
}

// Helper function to get priority level
function getPriorityLevel(type) {
  const priorities = {
    urgent: 'high',
    maintenance: 'medium',
    promotion: 'low',
    general: 'low',
  };
  return priorities[type] || 'low';
}

module.exports = router;
