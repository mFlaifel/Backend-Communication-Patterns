const express = require('express');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('../config/database');
const { authenticateToken, generateToken } = require('../middleware/auth');

const router = express.Router();

// FEATURE 1: Customer Account Management (Request/Response Pattern)
// Pattern Choice: HTTP REST API
// Reasoning: Immediate confirmation needed, standard CRUD operations

/**
 * POST /api/auth/register
 * Register a new user account
 */
router.post('/register', async (req, res) => {
  try {
    const {
      email,
      password,
      userType,
      firstName,
      lastName,
      phone,
      // Customer-specific fields
      address,
      // Restaurant-specific fields
      restaurantName,
      cuisineType,
    } = req.body;

    // Validation
    if (!email || !password || !userType || !firstName || !lastName) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['email', 'password', 'userType', 'firstName', 'lastName'],
      });
    }

    // Validate user type
    const validUserTypes = ['customer', 'restaurant', 'driver', 'support'];
    if (!validUserTypes.includes(userType)) {
      return res.status(400).json({
        error: 'Invalid user type',
        validTypes: validUserTypes,
      });
    }

    // Check if email already exists
    const existingUser = await query('SELECT id FROM users WHERE email = $1', [
      email.toLowerCase(),
    ]);

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user and related profile in transaction
    const result = await transaction(async (client) => {
      // Create user
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, user_type, first_name, last_name, phone)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, user_type, first_name, last_name, created_at`,
        [
          email.toLowerCase(),
          passwordHash,
          userType,
          firstName,
          lastName,
          phone,
        ]
      );

      const newUser = userResult.rows[0];

      // Create type-specific profile
      if (userType === 'customer') {
        await client.query(
          `INSERT INTO customer_profiles (user_id, address)
           VALUES ($1, $2)`,
          [newUser.id, address || null]
        );
      } else if (userType === 'restaurant') {
        if (!restaurantName) {
          throw new Error(
            'Restaurant name is required for restaurant accounts'
          );
        }
        await client.query(
          `INSERT INTO restaurants (user_id, name, cuisine_type)
           VALUES ($1, $2, $3)`,
          [newUser.id, restaurantName, cuisineType || null]
        );
      }

      return newUser;
    });

    // Generate JWT token
    const token = generateToken(result);

    res.status(201).json({
      message: 'Account created successfully',
      user: {
        id: result.id,
        email: result.email,
        userType: result.user_type,
        firstName: result.first_name,
        lastName: result.last_name,
        createdAt: result.created_at,
      },
      token,
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'Registration failed',
      message: error.message,
    });
  }
});

/**
 * POST /api/auth/login
 * User login with immediate confirmation
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required',
      });
    }

    // Get user from database
    const result = await query(
      `SELECT id, email, password_hash, user_type, first_name, last_name, is_active
       FROM users 
       WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT token
    const token = generateToken(user);

    // Return immediate confirmation
    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        userType: user.user_type,
        firstName: user.first_name,
        lastName: user.last_name,
      },
      token,
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /api/auth/profile
 * Get current user profile
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.user_type;

    // Get user info
    const userResult = await query(
      `SELECT id, email, user_type, first_name, last_name, phone, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    let profile = { ...user };

    // Get type-specific profile data
    if (userType === 'customer') {
      const customerResult = await query(
        'SELECT address, payment_info, preferences FROM customer_profiles WHERE user_id = $1',
        [userId]
      );
      if (customerResult.rows.length > 0) {
        profile.customerProfile = customerResult.rows[0];
      }
    } else if (userType === 'restaurant') {
      const restaurantResult = await query(
        'SELECT name, address, phone, cuisine_type FROM restaurants WHERE user_id = $1',
        [userId]
      );
      if (restaurantResult.rows.length > 0) {
        profile.restaurantProfile = restaurantResult.rows[0];
      }
    }

    res.json({ profile });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

/**
 * PUT /api/auth/profile
 * Update user profile with immediate reflection
 */
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.user_type;
    const { firstName, lastName, phone, address, restaurantName, cuisineType } =
      req.body;

    const updatedProfile = await transaction(async (client) => {
      // Update user table
      const userUpdateResult = await client.query(
        `UPDATE users 
         SET first_name = COALESCE($1, first_name),
             last_name = COALESCE($2, last_name),
             phone = COALESCE($3, phone),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
         RETURNING id, email, user_type, first_name, last_name, phone, updated_at`,
        [firstName, lastName, phone, userId]
      );

      const updatedUser = userUpdateResult.rows[0];

      // Update type-specific profile
      if (userType === 'customer' && address !== undefined) {
        await client.query(
          `UPDATE customer_profiles 
           SET address = $1, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $2`,
          [address, userId]
        );
      } else if (userType === 'restaurant') {
        if (restaurantName !== undefined || cuisineType !== undefined) {
          await client.query(
            `UPDATE restaurants 
             SET name = COALESCE($1, name),
                 cuisine_type = COALESCE($2, cuisine_type),
                 updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $3`,
            [restaurantName, cuisineType, userId]
          );
        }
      }

      return updatedUser;
    });

    // Return immediate confirmation of update
    res.json({
      message: 'Profile updated successfully',
      user: updatedProfile,
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Profile update failed' });
  }
});

/**
 * PUT /api/auth/payment
 * Manage payment methods (customer only)
 */
router.put('/payment', authenticateToken, async (req, res) => {
  try {
    if (req.user.user_type !== 'customer') {
      return res
        .status(403)
        .json({ error: 'Only customers can manage payment methods' });
    }

    const { paymentMethods } = req.body;

    if (!paymentMethods || !Array.isArray(paymentMethods)) {
      return res.status(400).json({ error: 'Invalid payment methods data' });
    }

    // In real app, you'd encrypt sensitive payment data
    // For demo purposes, we'll store a sanitized version
    const sanitizedPaymentMethods = paymentMethods.map((method) => ({
      type: method.type, // 'credit', 'debit', 'paypal', etc.
      lastFour: method.lastFour,
      expiryMonth: method.expiryMonth,
      expiryYear: method.expiryYear,
      isDefault: method.isDefault || false,
    }));

    await query(
      `UPDATE customer_profiles 
       SET payment_info = $1, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2`,
      [JSON.stringify(sanitizedPaymentMethods), req.user.id]
    );

    res.json({
      message: 'Payment methods updated successfully',
      paymentMethods: sanitizedPaymentMethods,
    });
  } catch (error) {
    console.error('Payment update error:', error);
    res.status(500).json({ error: 'Payment method update failed' });
  }
});

/**
 * POST /api/auth/logout
 * User logout (optional - mainly for client-side token removal)
 */
router.post('/logout', authenticateToken, (req, res) => {
  // In a more sophisticated system, you might:
  // 1. Add token to blacklist in Redis
  // 2. Log the logout event
  // 3. Clear any server-side session data

  res.json({
    message: 'Logout successful',
    instruction: 'Remove token from client storage',
  });
});

module.exports = router;
