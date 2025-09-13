-- FoodFast Database Schema
-- Initialize database with required tables

-- Users table (customers, restaurants, drivers, support agents)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    user_type VARCHAR(20) NOT NULL CHECK (user_type IN ('customer', 'restaurant', 'driver', 'support')),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone VARCHAR(20),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Customer profiles
CREATE TABLE customer_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    address TEXT,
    payment_info JSONB, -- Store encrypted payment methods
    preferences JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Restaurants
CREATE TABLE restaurants (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    address TEXT,
    phone VARCHAR(20),
    cuisine_type VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Menu items
CREATE TABLE menu_items (
    id SERIAL PRIMARY KEY,
    restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    image_url VARCHAR(500),
    image_status VARCHAR(20) DEFAULT 'pending' CHECK (image_status IN ('pending', 'processing', 'completed', 'failed')),
    is_available BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Orders
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES users(id),
    restaurant_id INTEGER REFERENCES restaurants(id),
    driver_id INTEGER REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'preparing', 'ready', 'picked_up', 'delivered', 'cancelled')),
    total_amount DECIMAL(10,2) NOT NULL,
    delivery_address TEXT NOT NULL,
    special_instructions TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Order items
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER REFERENCES menu_items(id),
    quantity INTEGER NOT NULL,
    price_per_item DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver locations
CREATE TABLE driver_locations (
    id SERIAL PRIMARY KEY,
    driver_id INTEGER REFERENCES users(id),
    order_id INTEGER REFERENCES orders(id),
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(driver_id, order_id)
);

-- Support chats
CREATE TABLE support_chats (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES users(id),
    agent_id INTEGER REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'closed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chat messages
CREATE TABLE chat_messages (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER REFERENCES support_chats(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES users(id),
    message TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'file')),
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Image uploads tracking
CREATE TABLE image_uploads (
    id SERIAL PRIMARY KEY,
    restaurant_id INTEGER REFERENCES restaurants(id),
    menu_item_id INTEGER REFERENCES menu_items(id),
    original_filename VARCHAR(255),
    file_path VARCHAR(500),
    file_size INTEGER,
    status VARCHAR(20) DEFAULT 'uploading' CHECK (status IN ('uploading', 'processing', 'completed', 'failed')),
    progress INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- System announcements
CREATE TABLE announcements (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    announcement_type VARCHAR(20) DEFAULT 'general' CHECK (announcement_type IN ('general', 'maintenance', 'promotion', 'urgent')),
    target_audience VARCHAR(20) DEFAULT 'all' CHECK (target_audience IN ('all', 'customers', 'restaurants', 'drivers')),
    is_active BOOLEAN DEFAULT true,
    scheduled_at TIMESTAMP,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for better performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_type ON users(user_type);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_driver_locations_driver ON driver_locations(driver_id);
CREATE INDEX idx_driver_locations_order ON driver_locations(order_id);
CREATE INDEX idx_chat_messages_chat ON chat_messages(chat_id);
CREATE INDEX idx_image_uploads_status ON image_uploads(status);

-- Insert sample data for testing
INSERT INTO users (email, password_hash, user_type, first_name, last_name, phone) VALUES
('customer@test.com', '$2a$10$example_hash', 'customer', 'John', 'Doe', '+1234567890'),
('restaurant@test.com', '$2a$10$example_hash', 'restaurant', 'Mario', 'Pizza', '+1234567891'),
('driver@test.com', '$2a$10$example_hash', 'driver', 'Jane', 'Smith', '+1234567892'),
('support@test.com', '$2a$10$example_hash', 'support', 'Alice', 'Johnson', '+1234567893');

INSERT INTO restaurants (user_id, name, address, cuisine_type) VALUES
(2, 'Mario''s Pizza Palace', '123 Main St, City', 'Italian');

INSERT INTO menu_items (restaurant_id, name, description, price) VALUES
(1, 'Margherita Pizza', 'Classic tomato and mozzarella', 12.99),
(1, 'Pepperoni Pizza', 'Pepperoni with mozzarella cheese', 14.99);