FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
RUN npm run build -w @company-brain/teamtrail-web

FROM nginx:1.27-alpine
COPY deploy/free-30-days/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
