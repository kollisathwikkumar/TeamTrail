FROM node:22-slim

WORKDIR /app

ARG VITE_AUTH0_DOMAIN=
ARG VITE_AUTH0_CLIENT_ID=
ARG VITE_AUTH0_AUDIENCE=
ENV VITE_AUTH0_DOMAIN=$VITE_AUTH0_DOMAIN \
    VITE_AUTH0_CLIENT_ID=$VITE_AUTH0_CLIENT_ID \
    VITE_AUTH0_AUDIENCE=$VITE_AUTH0_AUDIENCE

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

RUN npm ci

COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/

RUN npx turbo build

EXPOSE 3333

CMD ["node", "packages/server/dist/index.js", "--rest"]
