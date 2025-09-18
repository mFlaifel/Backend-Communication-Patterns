# FoodFast Backend Setup Instructions

## Prerequisites

- Docker & Docker Compose installed
- Node.js 18+ (if running locally)
- Git

## Quick Start with Docker

1. **Clone/Create the project structure:**

```bash
mkdir foodfast-backend
cd foodfast-backend
```

2. **Create all the files** as shown in the artifacts above

3. **Copy environment variables:**

```bash
cp .env.example .env
```

4. **Create required directories:**

```bash
mkdir -p uploads database src/routes src/sockets src/config src/middleware src/models
```

5. **Start the services:**

```bash
docker-compose up --build
```

## Manual Setup (without Docker)

1. **Install PostgreSQL and Redis locally**

2. **Create database:**

```bash
createdb foodfast
psql foodfast < database/init.sql
```

3. **Install dependencies:**

```bash
npm install
```

4. **Start Redis:**

```bash
redis-server
```

5. **Run the application:**

```bash
npm run dev
```

## Project Structure

```
foodfast-backend/
├── src/
│   ├── app.js                 # Main application
│   ├── config/
│   │   ├── database.js        # PostgreSQL config
│   │   └── redis.js           # Redis config
│   ├── routes/
│   │   ├── auth.js           # Feature 1: Account Management
│   │   ├── orders.js         # Feature 2: Order Tracking
│   │   ├── driver.js         # Feature 3: Driver Location
│   │   ├── restaurant.js     # Feature 4: Restaurant Notifications
│   │   ├── support.js        # Feature 5: Support Chat
│   │   ├── announcements.js  # Feature 6: Announcements
│   │   └── images.js         # Feature 7: Image Upload
│   ├── sockets/
│   │   ├── chatHandler.js    # WebSocket chat logic
│   │   ├── restaurantHandler.js # Restaurant notifications
│   │   └── announcementHandler.js # Announcements
│   ├── middleware/           # Auth, validation, etc.
│   └── models/              # Database models
├── database/
│   └── init.sql             # Database schema
├── uploads/                 # File uploads
├── docker-compose.yml
├── Dockerfile
├── package.json
└── .env
```

## Testing the Setup

1. **Health Check:**

```bash
curl http://localhost:3000/health
```

2. **Database Connection:**

```bash
docker-compose exec postgres psql -U foodfast_user -d foodfast -c "SELECT COUNT(*) FROM users;"
```

3. **Redis Connection:**

```bash
docker-compose exec redis redis-cli ping
```

## Useful Commands

```bash
# View logs
docker-compose logs -f app

# Access database
docker-compose exec postgres psql -U foodfast_user -d foodfast

# Access Redis CLI
docker-compose exec redis redis-cli

# Restart services
docker-compose restart

# Stop and remove containers
docker-compose down

# Rebuild containers
docker-compose up --build
```
