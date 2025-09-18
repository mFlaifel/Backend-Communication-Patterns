# FoodFast Backend Testing Guide

## Quick Start Testing

1. **Start the application:**

```bash
docker-compose up --build
```

2. **Wait for all services to be ready:**

- PostgreSQL: Check with `docker-compose logs postgres`
- Redis: Check with `docker-compose logs redis`
- App: Check with `curl http://localhost:3000/health`

## Feature Testing Examples

### Feature 1: Authentication (Request/Response)

```bash
# Register a customer
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "password123",
    "userType": "customer",
    "firstName": "John",
    "lastName": "Doe",
    "phone": "+1234567890",
    "address": "123 Main St"
  }'

# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "password123"
  }'

# Save the JWT token from response and use in subsequent requests:
export JWT_TOKEN="your_jwt_token_here"

# Get profile
curl -X GET http://localhost:3000/api/auth/profile \
  -H "Authorization: Bearer $JWT_TOKEN"
```

### Feature 2: Order Tracking (Short Polling)

```bash
# Create an order (customer)
curl -X POST http://localhost:3000/api/orders \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "restaurantId": 1,
    "deliveryAddress": "123 Main St, City",
    "items": [
      {"menuItemId": 1, "quantity": 2},
      {"menuItemId": 2, "quantity": 1}
    ],
    "specialInstructions": "Extra spicy please"
  }'

# Poll order status (every 60 seconds)
curl -X GET http://localhost:3000/api/orders/ORDER_ID/status \
  -H "Authorization: Bearer $JWT_TOKEN"

# Update order status (restaurant)
curl -X PUT http://localhost:3000/api/orders/ORDER_ID/status \
  -H "Authorization: Bearer $RESTAURANT_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "preparing"}'
```

### Feature 3: Driver Location (Server-Sent Events)

```bash
# Start SSE connection (customer)
curl -X GET http://localhost:3000/api/driver/location/ORDER_ID/stream \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Accept: text/event-stream"

# Update driver location (driver)
curl -X PUT http://localhost:3000/api/driver/location \
  -H "Authorization: Bearer $DRIVER_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "ORDER_ID",
    "latitude": 40.7128,
    "longitude": -74.0060
  }'
```

### Feature 4 & 5: WebSocket Testing (Restaurant Notifications & Chat)

Create an HTML test client:

```html
<!DOCTYPE html>
<html>
  <head>
    <title>FoodFast WebSocket Test</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.2/socket.io.js"></script>
  </head>
  <body>
    <div id="messages"></div>
    <input id="messageInput" placeholder="Type a message..." />
    <button onclick="sendMessage()">Send</button>

    <script>
      const socket = io('http://localhost:3000');

      // Replace with actual JWT token
      const JWT_TOKEN = 'your_jwt_token_here';

      // Test restaurant notifications
      socket.emit('join-restaurant', {
        restaurantId: 1,
        token: JWT_TOKEN,
      });

      // Test support chat
      socket.emit('join-support-chat', {
        chatId: 'CHAT_ID',
        token: JWT_TOKEN,
      });

      // Listen for events
      socket.on('new-order', (data) => {
        console.log('New order:', data);
        addMessage('New Order: ' + JSON.stringify(data));
      });

      socket.on('new-message', (data) => {
        console.log('New message:', data);
        addMessage(`${data.senderName}: ${data.message}`);
      });

      socket.on('new-announcement', (data) => {
        console.log('New announcement:', data);
        addMessage(`Announcement: ${data.title} - ${data.message}`);
      });

      function sendMessage() {
        const input = document.getElementById('messageInput');
        socket.emit('send-message', {
          message: input.value,
          tempId: Date.now(),
        });
        input.value = '';
      }

      function addMessage(message) {
        const div = document.createElement('div');
        div.textContent = new Date().toLocaleTimeString() + ': ' + message;
        document.getElementById('messages').appendChild(div);
      }
    </script>
  </body>
</html>
```

### Feature 6: Announcements (Pub/Sub)

```bash
# Create announcement (support/admin)
curl -X POST http://localhost:3000/api/announcements \
  -H "Authorization: Bearer $SUPPORT_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "System Maintenance",
    "message": "We will be performing maintenance tonight from 2-4 AM",
    "announcementType": "maintenance",
    "targetAudience": "all",
    "expiresAt": "2024-12-31T23:59:59Z"
  }'

# Get active announcements
curl -X GET http://localhost:3000/api/announcements/active \
  -H "Authorization: Bearer $JWT_TOKEN"
```

### Feature 7: Image Upload (Long Polling)

```bash
# Upload image
curl -X POST http://localhost:3000/api/images/upload \
  -H "Authorization: Bearer $RESTAURANT_JWT_TOKEN" \
  -F "image=@menu-item.jpg" \
  -F "menuItemId=1"

# Poll upload status (every 2 seconds until complete)
curl -X GET http://localhost:3000/api/images/status/UPLOAD_ID \
  -H "Authorization: Bearer $RESTAURANT_JWT_TOKEN"

# Long polling with timeout
curl -X GET "http://localhost:3000/api/images/status/UPLOAD_ID?timeout=30000" \
  -H "Authorization: Bearer $RESTAURANT_JWT_TOKEN"
```

## Load Testing

### Simple Load Test with curl

```bash
# Test concurrent order status polling
for i in {1..50}; do
  curl -X GET http://localhost:3000/api/orders/1/status \
    -H "Authorization: Bearer $JWT_TOKEN" &
done
wait
```

### WebSocket Load Test

```javascript
// Node.js script for WebSocket load testing
const io = require('socket.io-client');

const connections = 100;
const sockets = [];

for (let i = 0; i < connections; i++) {
  const socket = io('http://localhost:3000');

  socket.on('connect', () => {
    socket.emit('subscribe-announcements', {
      userType: 'customer',
      token: 'JWT_TOKEN',
    });
  });

  sockets.push(socket);
}

console.log(`Created ${connections} WebSocket connections`);
```

## Testing Each Communication Pattern

### 1. Request/Response (Auth)

- ✅ Immediate response
- ✅ HTTP status codes
- ✅ Error handling
- ✅ JWT token validation

### 2. Short Polling (Order Tracking)

- ✅ 60-second polling interval
- ✅ Cached responses
- ✅ Battery efficiency consideration
- ✅ Network fault tolerance

### 3. Server-Sent Events (Driver Location)

- ✅ One-way server-to-client streaming
- ✅ Automatic reconnection
- ✅ Heartbeat mechanism
- ✅ Mobile network compatibility

### 4. WebSockets (Restaurant & Chat)

- ✅ Bi-directional communication
- ✅ Real-time message delivery
- ✅ Room-based messaging
- ✅ Connection management

### 5. Pub/Sub (Announcements)

- ✅ Broadcast to multiple users
- ✅ Scalable architecture
- ✅ Channel-based routing
- ✅ Redis integration

### 6. Long Polling (Image Upload)

- ✅ Progress updates
- ✅ Timeout handling
- ✅ Graceful degradation
- ✅ Status persistence

## Performance Benchmarks

Expected performance for each pattern:

1. **Auth (Request/Response)**: <100ms response time
2. **Order Polling**: 60-second intervals, <50ms per request
3. **SSE Connections**: 1000+ concurrent connections
4. **WebSocket Messages**: <10ms delivery time
5. **Pub/Sub Broadcasting**: 10,000+ users simultaneously
6. **Long Polling**: 30-second timeout, efficient reconnection

## Common Issues & Solutions

### Database Connection Issues

```bash
# Check PostgreSQL
docker-compose exec postgres pg_isready -U foodfast_user

# Check tables
docker-compose exec postgres psql -U foodfast_user -d foodfast -c "\dt"
```

### Redis Connection Issues

```bash
# Check Redis
docker-compose exec redis redis-cli ping

# Check pub/sub
docker-compose exec redis redis-cli PUBSUB CHANNELS
```

### WebSocket Connection Issues

- Check CORS settings
- Verify JWT token format
- Monitor browser console for errors
- Use Socket.io client debugging: `localStorage.debug = 'socket.io-client:*'`

## Production Considerations

1. **Rate Limiting**: Implemented for all endpoints
2. **Authentication**: JWT with proper expiration
3. **Error Handling**: Comprehensive error responses
4. **Logging**: Structured logging for monitoring
5. **Security**: Helmet.js, input validation, SQL injection prevention
6. **Scalability**: Redis for session storage and pub/sub
7. **Monitoring**: Health check endpoints
8. **File Management**: Proper upload validation and cleanup

## Next Steps for Production

1. Add monitoring (Prometheus/Grafana)
2. Implement proper logging (Winston)
3. Add API documentation (Swagger)
4. Set up CI/CD pipeline
5. Add comprehensive unit tests
6. Implement proper caching strategies
7. Set up database migrations
8. Add rate limiting per user
9. Implement proper session management
10. Add metrics collection
