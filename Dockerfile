FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY public ./public
COPY catalog ./catalog

EXPOSE 3000
CMD ["npm", "start"]
