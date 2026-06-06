/**
 * Test HTTP status code filtering - GENERIC across all applications
 * Tests various log formats: Spring Boot, .NET, Python, Node.js
 */

// Extract the filtering function
function isExpectedException(logText) {
  if (!logText) return false;
  
  const statusPatterns = [
    /\b(?:status|Status|STATUS)[\s:=]+(\d{3})\b/i,
    /\bStatus\s*Code[\s:=]+(\d{3})\b/i,
    /^(?:Error\s+)?(\d{3})\s+(?:Error|Not Found|Bad Request|Internal Server|Service Unavailable)/im,
    /\breturning\s+(?:status\s+)?(\d{3})\b/i,
  ];
  
  for (const pattern of statusPatterns) {
    const match = logText.match(pattern);
    if (match) {
      const statusCode = parseInt(match[1], 10);
      if (statusCode >= 100 && statusCode < 600) {
        if (statusCode >= 400 && statusCode < 500) return true;
        if (statusCode >= 500 && statusCode < 600) return false;
      }
    }
  }
  
  const hasStackTrace = /\s+at\s+[\w$.]+\([^)]+\)/.test(logText) || 
                        /\s+in\s+.+\.cs:line\s+\d+/i.test(logText) ||
                        /File\s+".+\.py",\s+line\s+\d+/.test(logText);
  
  if (hasStackTrace) return false;
  
  const businessErrorIndicators = [
    /\b(?:not found|already exists|invalid|required|forbidden|unauthorized)\b/i,
  ];
  
  if (businessErrorIndicators.some(pattern => pattern.test(logText))) return true;
  
  return false;
}

// Test cases
const tests = [
  // ===== SPRING BOOT TESTS =====
  {
    name: 'Spring Boot 404 - ResourceNotFoundException',
    log: '2026-06-05 ERROR [freight-planning-admin-service] Status: 404, Error: ResourceNotFoundException: Terminal not found',
    expected: true,  // Skip (4xx)
  },
  {
    name: 'Spring Boot 500 - NullPointerException with stack trace',
    log: `2026-06-05 ERROR [service] Status: 500, Error: NullPointerException: Cannot invoke "String.toUpperCase()"
    at com.freightplanning.admin.service.DriverService.ensureDriverNamePresent(DriverService.java:135)`,
    expected: false,  // Create incident (5xx)
  },
  {
    name: 'Spring Boot 400 - Validation failed',
    log: '2026-06-05 ERROR [service] status=400, Validation failed: field is required',
    expected: true,  // Skip (4xx)
  },
  {
    name: 'Spring Boot 409 - Duplicate resource',
    log: '2026-06-05 ERROR [service] Status code: 409, DuplicateResourceException',
    expected: true,  // Skip (4xx)
  },
  
  // ===== .NET TESTS =====
  {
    name: '.NET 404 - Not Found',
    log: 'fail: Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddleware[1]\nStatus Code: 404\nResourceNotFoundException: Entity not found',
    expected: true,  // Skip (4xx)
  },
  {
    name: '.NET 500 - NullReferenceException with stack trace',
    log: `fail: Application[0] Status Code: 500
System.NullReferenceException: Object reference not set to an instance of an object
   at MyApp.Services.DriverService.Process() in /app/Services/DriverService.cs:line 42`,
    expected: false,  // Create incident (5xx)
  },
  
  // ===== PYTHON TESTS =====
  {
    name: 'Python Flask 404',
    log: 'ERROR - 404 Not Found - Resource does not exist in database',
    expected: true,  // Skip (4xx)
  },
  {
    name: 'Python 500 with traceback',
    log: `ERROR - 500 Internal Server Error
Traceback (most recent call last):
  File "/app/handler.py", line 78, in process
    result = data.upper()
AttributeError: 'NoneType' object has no attribute 'upper'`,
    expected: false,  // Create incident (5xx)
  },
  
  // ===== NODE.JS TESTS =====
  {
    name: 'Node.js Express 400',
    log: 'Error: ValidationError: Driver name is required\nreturning status 400',
    expected: true,  // Skip (4xx)
  },
  {
    name: 'Node.js Express 500',
    log: 'Error: TypeError: Cannot read property "toUpperCase" of null\nreturning status 500',
    expected: false,  // Create incident (5xx)
  },
  
  // ===== EDGE CASES =====
  {
    name: 'Unhandled exception - No status code but has stack trace',
    log: `NullPointerException: Cannot invoke method
    at com.example.Service.method(Service.java:100)`,
    expected: false,  // Create incident (unhandled exception)
  },
  {
    name: 'Business error message - No status code, no stack trace',
    log: 'ERROR: Terminal not found for code TERM-123',
    expected: true,  // Skip (business error)
  },
  {
    name: 'Generic error with "required" keyword',
    log: 'ERROR: CDL Number is required for DOT compliance',
    expected: true,  // Skip (validation)
  },
  {
    name: 'Infrastructure error without stack trace',
    log: 'ERROR: Database connection timeout after 30 seconds',
    expected: false,  // Create incident (infrastructure issue)
  },
];

// Run tests
console.log('='.repeat(80));
console.log('HTTP STATUS CODE FILTER TEST - GENERIC FOR ALL APPLICATIONS');
console.log('='.repeat(80));
console.log();

let passed = 0;
let failed = 0;

tests.forEach((test, idx) => {
  const result = isExpectedException(test.log);
  const success = result === test.expected;
  
  if (success) {
    passed++;
    console.log(`✅ PASS: ${test.name}`);
  } else {
    failed++;
    console.log(`❌ FAIL: ${test.name}`);
    console.log(`   Expected: ${test.expected ? 'Skip (4xx/business)' : 'Create incident (5xx/bug)'}`);
    console.log(`   Got:      ${result ? 'Skip (4xx/business)' : 'Create incident (5xx/bug)'}`);
  }
  console.log();
});

console.log('='.repeat(80));
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${tests.length} tests`);
console.log('='.repeat(80));

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED - Safe to deploy!\n');
  process.exit(0);
}
