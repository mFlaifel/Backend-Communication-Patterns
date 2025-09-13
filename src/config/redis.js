const redis = require('redis');

// Redis client for general operations
const client = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

// Redis client for subscriptions (pub/sub requires separate connection)
const subscriber = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

// Redis client for publishing
const publisher = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

// Error handlers
client.on('error', (err) => {
  console.error('Redis client error:', err);
});

subscriber.on('error', (err) => {
  console.error('Redis subscriber error:', err);
});

publisher.on('error', (err) => {
  console.error('Redis publisher error:', err);
});

// Connection handlers
client.on('connect', () => {
  console.log('Redis client connected');
});

subscriber.on('connect', () => {
  console.log('Redis subscriber connected');
});

publisher.on('connect', () => {
  console.log('Redis publisher connected');
});

// Connect to Redis
const connectRedis = async () => {
  try {
    await Promise.all([
      client.connect(),
      subscriber.connect(),
      publisher.connect(),
    ]);
    console.log('All Redis clients connected successfully');
  } catch (error) {
    console.error('Redis connection failed:', error);
    throw error;
  }
};

// Helper functions for common Redis operations
const redisHelpers = {
  // Set key with expiration
  setWithExpiry: async (key, value, expireInSeconds) => {
    try {
      await client.setEx(key, expireInSeconds, JSON.stringify(value));
    } catch (error) {
      console.error('Redis set error:', error);
      throw error;
    }
  },

  // Get and parse JSON value
  get: async (key) => {
    try {
      const value = await client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error('Redis get error:', error);
      throw error;
    }
  },

  // Delete key
  del: async (key) => {
    try {
      await client.del(key);
    } catch (error) {
      console.error('Redis delete error:', error);
      throw error;
    }
  },

  // Publish message to channel
  publish: async (channel, message) => {
    try {
      await publisher.publish(channel, JSON.stringify(message));
    } catch (error) {
      console.error('Redis publish error:', error);
      throw error;
    }
  },

  // Subscribe to channel
  subscribe: async (channel, callback) => {
    try {
      await subscriber.subscribe(channel, (message) => {
        try {
          const parsedMessage = JSON.parse(message);
          callback(parsedMessage);
        } catch (parseError) {
          console.error('Error parsing Redis message:', parseError);
        }
      });
    } catch (error) {
      console.error('Redis subscribe error:', error);
      throw error;
    }
  },

  // Hash operations for session storage
  hset: async (key, field, value) => {
    try {
      await client.hSet(key, field, JSON.stringify(value));
    } catch (error) {
      console.error('Redis hset error:', error);
      throw error;
    }
  },

  hget: async (key, field) => {
    try {
      const value = await client.hGet(key, field);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error('Redis hget error:', error);
      throw error;
    }
  },

  hdel: async (key, field) => {
    try {
      await client.hDel(key, field);
    } catch (error) {
      console.error('Redis hdel error:', error);
      throw error;
    }
  },
};

module.exports = {
  client,
  subscriber,
  publisher,
  connectRedis,
  ...redisHelpers,
};
