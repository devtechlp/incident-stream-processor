/**
 * One-time script to clean up duplicate incidents created before deduplication was fixed.
 * Groups incidents by incidentKey and keeps only the first occurrence.
 */

require('dotenv').config({ path: '.env' });
const { getDB } = require('./config/db');

async function cleanupDuplicates() {
  const db = await getDB();
  const col = db.collection(process.env.MONGO_COLLECTION);
  
  console.log('Finding duplicates...');
  
  // Find all incidents that don't have an incidentKey (old schema)
  const oldIncidents = await col.find({ incidentKey: { $exists: false } }).toArray();
  console.log(`Found ${oldIncidents.length} incidents without incidentKey (old schema)`);
  
  // Delete old schema incidents
  if (oldIncidents.length > 0) {
    const result = await col.deleteMany({ incidentKey: { $exists: false } });
    console.log(`Deleted ${result.deletedCount} old schema incidents`);
  }
  
  // Find duplicate incidents (same incidentKey)
  const duplicates = await col.aggregate([
    { $group: { 
        _id: '$incidentKey', 
        count: { $sum: 1 },
        ids: { $push: '$_id' },
        firstOccurred: { $min: '$occurredAt' }
    }},
    { $match: { count: { $gt: 1 } }}
  ]).toArray();
  
  console.log(`Found ${duplicates.length} incident(s) with duplicates`);
  
  for (const dup of duplicates) {
    console.log(`  - ${dup._id}: ${dup.count} duplicates`);
    
    // Keep the first one, delete the rest
    const idsToDelete = dup.ids.slice(1);
    await col.deleteMany({ _id: { $in: idsToDelete } });
    
    // Update the kept incident with correct occurrence count
    await col.updateOne(
      { _id: dup.ids[0] },
      { $set: { occurrenceCount: dup.count } }
    );
    
    console.log(`    Kept first incident, deleted ${idsToDelete.length} duplicates, set occurrenceCount=${dup.count}`);
  }
  
  console.log('\nCleanup complete!');
  process.exit(0);
}

cleanupDuplicates().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
