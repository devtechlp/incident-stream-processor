// Fix MongoDB index issue - Drop old errorId index
// The code was updated to use incidentId instead of errorId
// This causes conflicts with the old ux_errorId unique index

use('incident_management');

// Check existing indexes
print('Current indexes on service-error-logs:');
db.getCollection('service-error-logs').getIndexes().forEach(idx => {
  print(`  ${idx.name}: ${JSON.stringify(idx.key)}`);
});

// Drop the old errorId index if it exists
try {
  db.getCollection('service-error-logs').dropIndex('ux_errorId');
  print('\n✓ Dropped old ux_errorId index');
} catch (e) {
  if (e.code === 27) {
    print('\n✓ ux_errorId index does not exist (already removed)');
  } else {
    print(`\n✗ Error dropping index: ${e.message}`);
  }
}

print('\nIndexes after cleanup:');
db.getCollection('service-error-logs').getIndexes().forEach(idx => {
  print(`  ${idx.name}: ${JSON.stringify(idx.key)}`);
});

print('\n✓ Index cleanup complete. Restart incident-stream-processor to continue.');
