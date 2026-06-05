# MongoDB Incident Queries

## Quick Reference - What's in MongoDB

### Document Structure
```javascript
{
  // SORTABLE ID: "1717624800000-1234" (timestamp-random)
  incidentId: "1717624800000-1234",
  
  // TRACE ID: From application logs (correlation)
  traceId: "abc123ef",
  
  // SERVICE & ERROR INFO
  serviceName: "freight-planning-admin-service",
  exceptionType: "NullPointerException",
  exceptionMessage: "Cannot invoke 'String.toUpperCase()' because...",
  stackTrace: "Full multi-line stack trace...",
  
  // TIMESTAMPS
  createdAt: ISODate("2026-06-05T22:00:00Z"),    // When first seen
  occurredAt: ISODate("2026-06-05T22:00:42Z"),   // When error happened
  lastSeenAt: ISODate("2026-06-05T22:05:30Z"),   // Last occurrence
  
  // DEDUPLICATION
  incidentKey: "freight-planning-admin-service:NullPointerException:DriverService.java:136",
  occurrenceCount: 5,  // How many times this exact error occurred
  
  // STATUS
  healingStatus: "PENDING",  // PENDING, ANALYZING, FIXING, PULL_REQUEST_CREATED, etc.
}
```

---

## Common Queries

### 1. **Get All Incidents (Newest First)**
```javascript
use freight_planning;

db.incidents.find()
  .sort({ incidentId: -1 })  // Sort by ID (newest first)
  .limit(20);
```

### 2. **Get Incidents by Service**
```javascript
db.incidents.find({ 
  serviceName: "freight-planning-admin-service" 
})
.sort({ incidentId: -1 })
.limit(10);
```

### 3. **Find by Trace ID (Specific Request)**
```javascript
db.incidents.find({ 
  traceId: "abc123ef" 
});
```

### 4. **Get Pending Incidents (Not Yet Processed)**
```javascript
db.incidents.find({ 
  healingStatus: "PENDING" 
})
.sort({ createdAt: -1 });
```

### 5. **Get Top Errors by Occurrence**
```javascript
db.incidents.find()
  .sort({ occurrenceCount: -1 })
  .limit(10);
```

### 6. **Get Recent Errors (Last Hour)**
```javascript
db.incidents.find({
  createdAt: { 
    $gte: new Date(Date.now() - 60 * 60 * 1000) 
  }
})
.sort({ createdAt: -1 });
```

### 7. **Search by Exception Type**
```javascript
db.incidents.find({ 
  exceptionType: "NullPointerException" 
})
.sort({ incidentId: -1 });
```

### 8. **Count Incidents by Service**
```javascript
db.incidents.aggregate([
  { $group: { 
      _id: "$serviceName", 
      count: { $sum: 1 },
      totalOccurrences: { $sum: "$occurrenceCount" }
  }},
  { $sort: { count: -1 }}
]);
```

---

## Indexes Created

These indexes make queries fast:

1. **`incidentKey`** (unique) - Deduplication
2. **`healingStatus`** - Filter by status
3. **`incidentId`** (descending) - Sort newest first
4. **`createdAt`** (descending) - Time-based queries
5. **`traceId`** (sparse) - Correlation queries

---

## Easy Sorting

### By Incident ID (Recommended)
```javascript
// Newest incidents first
db.incidents.find().sort({ incidentId: -1 });

// Oldest incidents first
db.incidents.find().sort({ incidentId: 1 });
```

**Why incidentId?**
- Format: `timestamp-random` (e.g., `1717624800000-1234`)
- Sortable: Higher number = newer incident
- Unique: Random suffix prevents collisions
- Simple: Just one field to sort by

### By Creation Time
```javascript
db.incidents.find().sort({ createdAt: -1 });
```

### By Occurrence Count
```javascript
// Most frequent errors first
db.incidents.find().sort({ occurrenceCount: -1 });
```

---

## Trace ID Correlation

### Find All Logs from One Request
```javascript
// 1. Get incident by trace ID
const incident = db.incidents.findOne({ traceId: "abc123ef" });

// 2. View full stack trace
print(incident.stackTrace);

// 3. Check how many times it occurred
print("Occurred", incident.occurrenceCount, "times");
```

### Cross-Reference with Dynatrace
```
DQL: fetch logs | filter trace_id == "abc123ef"
```

Both will show the same request!

---

## Update Incident Status

```javascript
// Mark as analyzed
db.incidents.updateOne(
  { incidentKey: "freight-planning-admin-service:NullPointerException:DriverService.java:136" },
  { $set: { healingStatus: "ANALYZING" }}
);

// Check current status
db.incidents.findOne({ incidentId: "1717624800000-1234" }, { healingStatus: 1 });
```

---

## Clean Up Old Incidents

```javascript
// Archive incidents older than 30 days
db.incidents.updateMany(
  { 
    createdAt: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    healingStatus: { $in: ["PULL_REQUEST_CREATED", "RESOLVED"] }
  },
  { $set: { healingStatus: "ARCHIVED" }}
);

// Delete archived incidents older than 90 days
db.incidents.deleteMany({
  healingStatus: "ARCHIVED",
  createdAt: { $lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }
});
```

---

## Performance Tips

1. **Always use indexes** - Queries above use indexed fields
2. **Limit results** - Use `.limit(N)` for large result sets
3. **Project fields** - Only get fields you need: `.find({}, { stackTrace: 0 })`
4. **Use incidentId for sorting** - Faster than multiple fields

---

## Example: Daily Error Report

```javascript
// Get today's incidents grouped by service
const startOfDay = new Date();
startOfDay.setHours(0,0,0,0);

db.incidents.aggregate([
  { $match: { createdAt: { $gte: startOfDay }}},
  { $group: {
      _id: "$serviceName",
      count: { $sum: 1 },
      totalOccurrences: { $sum: "$occurrenceCount" },
      pending: { 
        $sum: { $cond: [{ $eq: ["$healingStatus", "PENDING"] }, 1, 0] }
      }
  }},
  { $sort: { count: -1 }}
]);
```

Result:
```
{
  _id: "freight-planning-admin-service",
  count: 3,              // 3 unique errors
  totalOccurrences: 15,  // Happened 15 times total
  pending: 2             // 2 not yet processed
}
```
