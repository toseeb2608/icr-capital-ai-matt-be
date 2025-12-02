# ICR Capital AI - Backend

Node.js/Express backend API server for ICR Capital AI platform.

## Tech Stack

- **Runtime**: Node.js (ES Modules)
- **Framework**: Express.js
- **Database**: MongoDB (Mongoose) + PostgreSQL
- **Authentication**: JWT + Azure AD
- **AI Services**: OpenAI, Anthropic, Google AI
- **Real-time**: Socket.io
- **File Storage**: AWS S3

## Getting Started

### Prerequisites
- Node.js (v16+)
- MongoDB
- PostgreSQL
- npm or yarn

### Installation

1. Clone the repository:
```bash
git clone https://github.com/toseeb2608/icr-capital-ai-matt-be.git
cd icr-capital-ai-matt-be
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
- Copy `.env.example` to `.env` (if exists)
- Configure your environment variables:
  - MongoDB connection string
  - PostgreSQL connection details
  - JWT secret
  - Azure AD credentials
  - AI service API keys (OpenAI, Anthropic, Google AI)
  - AWS S3 credentials

4. Run the server:
```bash
npm start
```

The server will run on port 8011 (or as configured in `.env`).

## API Documentation

See `docs/Collab-AI-API.yaml` for complete API documentation.

## Project Structure

```
├── controllers/      # Request handlers
├── models/          # Mongoose models
├── routes/          # API routes
├── middleware/      # Custom middleware
├── utils/           # Utility functions
├── config.js        # Configuration
└── index.js         # Entry point
```

## Branching Strategy

- `main` - Production-ready code
- `develop` - Development branch
- `feature/*` - Feature branches
- `bugfix/*` - Bug fix branches

## License

ISC

