const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const dirsToScan = ['src', 'test', 'scripts'];
let hasErrors = false;

console.log('[Lint] Checking JavaScript syntax and file integrity...');

function scanDir(dir) {
  const fullDir = path.join(rootDir, dir);
  if (!fs.existsSync(fullDir)) return;

  const entries = fs.readdirSync(fullDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(fullDir, entry.name);
    if (entry.isDirectory()) {
      scanDir(path.join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      checkFile(fullPath);
    }
  }
}

function checkFile(filePath) {
  const relPath = path.relative(rootDir, filePath);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // Basic syntax parsing test using Function constructor or node syntax check
    new Function(content);
    console.log(`  ✓ ${relPath}`);
  } catch (err) {
    console.error(`  ✗ Syntax error in ${relPath}:`, err.message);
    hasErrors = true;
  }
}

for (const d of dirsToScan) {
  scanDir(d);
}

if (hasErrors) {
  console.error('\n[Lint] Lint check failed with errors.');
  process.exit(1);
} else {
  console.log('\n[Lint] All JavaScript files passed syntax and structure check.');
  process.exit(0);
}
