#
# container docker pour dila.js
#
# https://github.com/SocialGouv/dila2sql/tree/master/packages/dila.js
#
# build: `docker build -t dila2sql-api packages/api`
#

FROM node:11-alpine

WORKDIR /app

COPY package.json ./

COPY yarn.lock ./

RUN yarn install

COPY . .

EXPOSE 8080

ENV PORT=8080

ENV NODE_ENV=production

ENTRYPOINT [ "yarn", "start" ]
