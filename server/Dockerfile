FROM node:20-alpine
WORKDIR /app

# Copy server package definitions
COPY package*.json ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

ENV HOST=0.0.0.0
ENV PORT=4000
EXPOSE 4000

CMD ["node", "dist/index.js"]
