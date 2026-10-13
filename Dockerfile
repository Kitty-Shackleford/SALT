FROM node:26
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy remaining files (before the CSS build so the fresh output is not
# overwritten by the committed public/css/tailwind.css)
COPY . .

# Build Tailwind CSS
RUN npm run build:css

EXPOSE 3000
CMD ["node", "server.js"]
