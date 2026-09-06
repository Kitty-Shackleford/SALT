FROM node:22
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source files before generating final artifacts
COPY . .

# Build Tailwind CSS after the source copy so tracked output cannot overwrite it.
RUN npm run build:css

EXPOSE 3000
CMD ["node", "server.js"]
