FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /src/dist /usr/share/nginx/html/surface-measurement
EXPOSE 8080
RUN printf 'server {\n  listen 8080;\n  root /usr/share/nginx/html;\n  location /surface-measurement/ { try_files $uri $uri/ /surface-measurement/index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
