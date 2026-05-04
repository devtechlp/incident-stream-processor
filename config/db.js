const { MongoClient } = require('mongodb');
require('dotenv').config();

let client;

async function connectDB() {
  if (!client) {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    console.log('Connected to MongoDB');
  }
  return client;
}

async function getDB() {
  const c = await connectDB();
  return c.db(process.env.MONGO_DB_NAME);
}

module.exports = { connectDB, getDB };
