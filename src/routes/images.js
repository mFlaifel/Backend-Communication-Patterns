const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../config/database');
const { authenticateToken, authorize } = require('../middleware/auth');
const { setWithExpiry, get } = require('../config/redis');

const router = express.Router();

// FEATURE 7: Image Upload & Processing (Long Polling Pattern)
// Pattern Choice: Long Polling for status updates
// Reasoning: Processing takes time (30s-3min), needs progress updates, handles disconnections

// Configure multer for file upload
const storage = multer.memoryStorage(); // Store in memory for processing
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    // Check file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error('Invalid file type. Only JPEG, PNG, and WebP are allowed.'),
        false
      );
    }
  },
});

/**
 * POST /api/images/upload
 * Upload and process menu item image
 */
router.post(
  '/upload',
  authenticateToken,
  authorize(['restaurant']),
  upload.single('image'),
  async (req, res) => {
    try {
      const { menuItemId } = req.body;
      const userId = req.user.id;

      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
      }

      if (!menuItemId) {
        return res.status(400).json({ error: 'Menu item ID is required' });
      }

      // Verify restaurant owns this menu item
      const menuItemCheck = await query(
        `SELECT mi.id, mi.name, r.id as restaurant_id
       FROM menu_items mi
       JOIN restaurants r ON mi.restaurant_id = r.id
       WHERE mi.id = $1 AND r.user_id = $2`,
        [menuItemId, userId]
      );

      if (menuItemCheck.rows.length === 0) {
        return res
          .status(404)
          .json({ error: 'Menu item not found or access denied' });
      }

      const menuItem = menuItemCheck.rows[0];

      // Create upload record
      const generatedUploadId = uuidv4();
      const originalFilename = req.file.originalname;
      const fileExtension = path.extname(originalFilename);
      const filename = `${generatedUploadId}${fileExtension}`;
      const filePath = path.join('uploads', 'menu-items', filename);

      // Change this part of the code:
      const uploadRecord = await query(
        `INSERT INTO image_uploads (restaurant_id, menu_item_id, original_filename, file_path, file_size, status, progress)
         VALUES ($1, $2, $3, $4, $5, 'uploading', 0)
         RETURNING id, created_at`,
        [
          menuItem.restaurant_id,
          menuItemId,
          originalFilename,
          filePath,
          req.file.size,
        ]
      );

      // Then use the returned ID from the database:
      const uploadId = uploadRecord.rows[0].id;
      // Start asynchronous processing
      processImageAsync(uploadId, req.file.buffer, filePath, menuItemId);

      res.status(202).json({
        message: 'Image upload started',
        uploadId,
        menuItemId,
        filename: originalFilename,
        fileSize: req.file.size,
        status: 'uploading',
        createdAt: uploadRecord.rows[0].created_at,
        polling: {
          statusEndpoint: `/api/images/status/${uploadId}`,
          recommendedInterval: 2000, // Poll every 2 seconds
          instruction: 'Use long polling for real-time status updates',
        },
      });
    } catch (error) {
      console.error('Image upload error:', error);

      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          return res
            .status(400)
            .json({ error: 'File too large. Maximum size is 10MB.' });
        }
        return res.status(400).json({ error: error.message });
      }

      res.status(500).json({ error: 'Image upload failed' });
    }
  }
);

/**
 * GET /api/images/status/:uploadId
 * Long polling endpoint for image processing status
 */
router.get(
  '/status/:uploadId',
  authenticateToken,
  authorize(['restaurant']),
  async (req, res) => {
    try {
      const { uploadId } = req.params;
      const userId = req.user.id;
      const timeout = parseInt(req.query.timeout) || 30000; // Default 30 second timeout
      const maxTimeout = 60000; // Maximum 60 seconds

      // Verify access to this upload
      const uploadCheck = await query(
        `SELECT iu.id, iu.status, iu.progress, iu.error_message, iu.updated_at
       FROM image_uploads iu
       JOIN restaurants r ON iu.restaurant_id = r.id
       WHERE iu.id = $1 AND r.user_id = $2`,
        [uploadId, userId]
      );

      if (uploadCheck.rows.length === 0) {
        return res
          .status(404)
          .json({ error: 'Upload not found or access denied' });
      }

      const upload = uploadCheck.rows[0];

      // If processing is complete or failed, return immediately
      if (['completed', 'failed'].includes(upload.status)) {
        return res.json({
          uploadId,
          status: upload.status,
          progress: upload.progress,
          errorMessage: upload.error_message,
          lastUpdated: upload.updated_at,
          completed: true,
        });
      }

      // Implement long polling
      const pollTimeout = Math.min(timeout, maxTimeout);
      const startTime = Date.now();
      const pollInterval = 1000; // Check every 1 second

      const pollForChanges = async () => {
        while (Date.now() - startTime < pollTimeout) {
          // Check current status
          const currentStatus = await query(
            'SELECT status, progress, error_message, updated_at FROM image_uploads WHERE id = $1',
            [uploadId]
          );

          if (currentStatus.rows.length === 0) {
            break;
          }

          const current = currentStatus.rows[0];

          // Return if status changed to completed or failed
          if (['completed', 'failed'].includes(current.status)) {
            return res.json({
              uploadId,
              status: current.status,
              progress: current.progress,
              errorMessage: current.error_message,
              lastUpdated: current.updated_at,
              completed: true,
            });
          }

          // Return if progress changed significantly
          if (Math.abs(current.progress - upload.progress) >= 5) {
            return res.json({
              uploadId,
              status: current.status,
              progress: current.progress,
              errorMessage: current.error_message,
              lastUpdated: current.updated_at,
              completed: false,
              polling: {
                continue: true,
                nextPollDelay: 2000,
              },
            });
          }

          // Wait before next check
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }

        // Timeout reached, return current status
        const finalStatus = await query(
          'SELECT status, progress, error_message, updated_at FROM image_uploads WHERE id = $1',
          [uploadId]
        );

        const final = finalStatus.rows[0];

        res.json({
          uploadId,
          status: final.status,
          progress: final.progress,
          errorMessage: final.error_message,
          lastUpdated: final.updated_at,
          completed: ['completed', 'failed'].includes(final.status),
          timeout: true,
          polling: {
            continue: !['completed', 'failed'].includes(final.status),
            nextPollDelay: 2000,
          },
        });
      };

      await pollForChanges();
    } catch (error) {
      console.error('Image status polling error:', error);
      res.status(500).json({ error: 'Failed to get upload status' });
    }
  }
);

/**
 * GET /api/images/uploads/restaurant
 * Get all uploads for current restaurant
 */
router.get(
  '/uploads/restaurant',
  authenticateToken,
  authorize(['restaurant']),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const { status, page = 1, limit = 20 } = req.query;

      let whereClause = 'WHERE r.user_id = $1';
      const params = [userId];
      let paramCount = 1;

      if (status) {
        paramCount++;
        whereClause += ` AND iu.status = $${paramCount}`;
        params.push(status);
      }

      const offset = (page - 1) * limit;
      paramCount++;
      params.push(limit);
      paramCount++;
      params.push(offset);

      const result = await query(
        `SELECT iu.id, iu.original_filename, iu.file_size, iu.status, iu.progress,
              iu.error_message, iu.created_at, iu.updated_at,
              mi.name as menu_item_name
       FROM image_uploads iu
       JOIN restaurants r ON iu.restaurant_id = r.id
       LEFT JOIN menu_items mi ON iu.menu_item_id = mi.id
       ${whereClause}
       ORDER BY iu.created_at DESC
       LIMIT $${paramCount - 1} OFFSET $${paramCount}`,
        params
      );

      const uploads = result.rows.map((upload) => ({
        id: upload.id,
        originalFilename: upload.original_filename,
        menuItemName: upload.menu_item_name,
        fileSize: upload.file_size,
        status: upload.status,
        progress: upload.progress,
        errorMessage: upload.error_message,
        createdAt: upload.created_at,
        updatedAt: upload.updated_at,
        statusEndpoint: `/api/images/status/${upload.id}`,
      }));

      res.json({
        uploads,
        count: uploads.length,
        pagination: {
          currentPage: parseInt(page),
          limit: parseInt(limit),
        },
      });
    } catch (error) {
      console.error('Restaurant uploads fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch uploads' });
    }
  }
);

/**
 * DELETE /api/images/:uploadId
 * Cancel or delete an image upload
 */
router.delete(
  '/:uploadId',
  authenticateToken,
  authorize(['restaurant']),
  async (req, res) => {
    try {
      const { uploadId } = req.params;
      const userId = req.user.id;

      // Verify access and get upload info
      const uploadResult = await query(
        `SELECT iu.id, iu.status, iu.file_path
       FROM image_uploads iu
       JOIN restaurants r ON iu.restaurant_id = r.id
       WHERE iu.id = $1 AND r.user_id = $2`,
        [uploadId, userId]
      );

      if (uploadResult.rows.length === 0) {
        return res
          .status(404)
          .json({ error: 'Upload not found or access denied' });
      }

      const upload = uploadResult.rows[0];

      // Delete file if it exists
      if (upload.file_path) {
        try {
          await fs.unlink(upload.file_path);
        } catch (fileError) {
          console.error('File deletion error:', fileError);
        }
      }

      // Delete upload record
      await query('DELETE FROM image_uploads WHERE id = $1', [uploadId]);

      res.json({
        message: 'Upload cancelled/deleted successfully',
        uploadId,
        status: 'deleted',
      });
    } catch (error) {
      console.error('Upload deletion error:', error);
      res.status(500).json({ error: 'Failed to delete upload' });
    }
  }
);

// Async function to process image
async function processImageAsync(uploadId, imageBuffer, filePath, menuItemId) {
  try {
    // Update status to processing
    await updateUploadStatus(uploadId, 'processing', 10);

    // Ensure upload directory exists
    const uploadDir = path.dirname(filePath);
    await fs.mkdir(uploadDir, { recursive: true });

    // Simulate processing time and update progress
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await updateUploadStatus(uploadId, 'processing', 30, 'Resizing image...');

    // Process image with sharp
    const processedImage = await sharp(imageBuffer)
      .resize(800, 600, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 85,
        progressive: true,
      })
      .toBuffer();

    await updateUploadStatus(uploadId, 'processing', 60, 'Optimizing image...');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Save processed image
    await fs.writeFile(filePath, processedImage);

    await updateUploadStatus(
      uploadId,
      'processing',
      80,
      'Updating database...'
    );

    // Update menu item with image URL
    await query(
      `UPDATE menu_items 
       SET image_url = $1, image_status = 'completed', updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [`/uploads/menu-items/${path.basename(filePath)}`, menuItemId]
    );

    // Final status update
    await updateUploadStatus(
      uploadId,
      'completed',
      100,
      'Image processing completed'
    );

    console.log(`Image processing completed for upload ${uploadId}`);
  } catch (error) {
    console.error(`Image processing failed for upload ${uploadId}:`, error);
    await updateUploadStatus(uploadId, 'failed', 0, error.message);
  }
}

// Helper function to update upload status
async function updateUploadStatus(uploadId, status, progress, message = null) {
  try {
    await query(
      `UPDATE image_uploads 
       SET status = $1, progress = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [status, progress, message, uploadId]
    );

    // Cache status for quick access
    await setWithExpiry(
      `image_upload_status:${uploadId}`,
      {
        uploadId,
        status,
        progress,
        errorMessage: message,
        lastUpdated: new Date().toISOString(),
      },
      3600
    );
  } catch (error) {
    console.error(`Failed to update status for upload ${uploadId}:`, error);
  }
}

module.exports = router;
