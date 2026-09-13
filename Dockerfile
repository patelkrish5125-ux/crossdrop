FROM node:20-slim
WORKDIR /app

# Copy root and workspace package and npm configuration files
COPY package*.json .npmrc ./
COPY client/package*.json client/.npmrc ./client/
COPY server/package*.json ./server/

# Install dependencies across all workspaces with optional dependencies enabled
RUN npm install --include=optional

# Copy source code
COPY . .

# Run production build (client + server + dist sync)
RUN npm run build

ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# Start unified server
CMD ["npm", "start"]
