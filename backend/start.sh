#!/bin/bash
echo "Starting Render Deployment Script..."

echo "1. Running Database Migrations..."
npx prisma migrate deploy

echo "2. Running Database Seed..."
npm run db:seed || echo "Warning: Seed script failed, but continuing..."

echo "3. Starting BullMQ Background Worker..."
npm run start:worker &

echo "4. Starting Express API in foreground..."
npm run start:api
