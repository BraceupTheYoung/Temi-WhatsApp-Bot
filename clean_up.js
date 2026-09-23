const fs = require('fs');

const filesToClean = [
  'search_conversations.js',
  'results.txt',
  'detect_format.js',
  'check_brains.js',
  'search_markdowns.js',
  'markdown_results.txt',
  'search_transcripts.js',
  'transcript_results.txt',
  'test_decompression.js'
];

filesToClean.forEach(file => {
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
      console.log(`Deleted: ${file}`);
    } catch (e) {
      console.error(`Error deleting ${file}:`, e.message);
    }
  }
});
