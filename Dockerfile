FROM node:20-alpine
WORKDIR /app

# Copy root and workspace package files
COPY package*.json ./
COPY client/package*.json ./client/
COPY server/package*.json ./server/

# Install dependencies across all workspaces
RUN npm install

# Copy source code
COPY . .

# Run production build (client + server + dist sync)
RUN npm run build

ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# Start unified server
CMD ["npm", "start"]
