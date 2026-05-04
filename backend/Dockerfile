FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV MASTER_KEY_FILE=/app/data/master.key
ENV PORT=5000
RUN npm run build
EXPOSE 5000
CMD ["node", "dist/main.js"]
