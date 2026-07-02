FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package configuration files
COPY package*.json ./

# Install only production dependencies
RUN npm install --only=production

# Copy backend entry and static web application files
COPY server.js ./
COPY public/ ./public/

# Create folder for persistent database storage
RUN mkdir -p /app/data

# Expose server port
EXPOSE 3000

# Set default environmental variables
ENV PORT=3000
ENV DATABASE_PATH=/app/data/voting.db

# Define volume mount point
VOLUME ["/app/data"]

# Start the Node.js server
CMD ["node", "server.js"]
