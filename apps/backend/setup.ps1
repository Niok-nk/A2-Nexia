#!/usr/bin/env powershell

# Quick Start Script for Chatbot IA + Mini CRM Backend
# Run this to set up environment and start development server

Write-Host "🚀 Starting Chatbot IA + Mini CRM Backend Setup" -ForegroundColor Cyan
Write-Host ""

# Check if .env exists
if (-Not (Test-Path ".env")) {
    Write-Host "⚠️  No .env file found. Creating from .env.example..." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
    Write-Host "✅ Created .env file" -ForegroundColor Green
    Write-Host "⚠️  IMPORTANT: Edit .env and add your GEMINI_API_KEY" -ForegroundColor Red
    Write-Host ""
}

# Check if node_modules exists
if (-Not (Test-Path "node_modules")) {
    Write-Host "📦 Installing dependencies..." -ForegroundColor Yellow
    npm install
    Write-Host "✅ Dependencies installed" -ForegroundColor Green
}

# Generate Prisma client
Write-Host "🔧 Generating Prisma client..." -ForegroundColor Yellow
npx prisma generate
Write-Host "✅ Prisma client generated" -ForegroundColor Green

# Run database migrations
if (-Not (Test-Path "prisma\dev.db")) {
    Write-Host "🗄️  Running database migrations..." -ForegroundColor Yellow
    npx prisma migrate dev --name init
    Write-Host "✅ Database migrated" -ForegroundColor Green
}

Write-Host ""
Write-Host "🎉 Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Edit .env and add your GEMINI_API_KEY"
Write-Host "2. Run 'npm run dev' to start the server"
Write-Host ""
Write-Host "📖 For more info, see CONFIG.md or ENV_SETUP.md" -ForegroundColor Cyan
