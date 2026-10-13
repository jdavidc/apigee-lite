FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV APIGEE_LITE_DATA=/app/data
EXPOSE 9000 9001 9002
VOLUME ["/app/data"]
CMD ["node", "server.js"]
