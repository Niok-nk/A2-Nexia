import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
p.userData.findMany().then(r => {
  console.log('UserData count:', r.length);
  console.log('Rows:', JSON.stringify(r, null, 2));
}).catch(e => {
  console.error('Error:', e.message);
}).finally(() => p.$disconnect());
