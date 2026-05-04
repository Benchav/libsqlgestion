FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV MASTER_KEY_FILE=/app/data/master.key
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/main.js"]
