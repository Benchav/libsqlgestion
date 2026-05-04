FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV INTERNAL_API_URL=http://backend:3000/api/v1
RUN npm run build
EXPOSE 3000
CMD ["npm", "run", "start"]
