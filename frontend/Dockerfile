FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV PORT=5001
ENV INTERNAL_API_URL=http://backend:5000/api/v1
RUN npm run build
EXPOSE 5001
CMD ["npm", "run", "start"]
