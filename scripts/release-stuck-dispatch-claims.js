require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

async function main() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const col = client.db(process.env.MONGO_DB_NAME).collection(process.env.MONGO_COLLECTION);

  const result = await col.updateMany(
    { healingStatus: 'PENDING', dispatchedAt: { $exists: true } },
    { $unset: { dispatchedAt: '', dispatchedTo: '' } },
  );

  console.log(`Released ${result.modifiedCount} stuck dispatch claim(s)`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
