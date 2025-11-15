#!/bin/bash
echo "Creating all DocBot files..."

# Create remaining core files in ~/docbot
cd ~/docbot

# Create basic placeholder icons
for size in 16 48 128; do
  echo "<svg width='$size' height='$size' xmlns='http://www.w3.org/2000/svg'><rect width='$size' height='$size' fill='#667eea'/><text x='50%' y='50%' text-anchor='middle' dy='.3em' fill='white' font-size='${size}px' font-family='Arial'>D</text></svg>" > icons/icon$size.png
done

echo '✅ DocBot created!'
echo '📂 Load in Chrome from: \\wsl$\Ubuntu\home\tbarthen\docbot'
echo ''
echo 'Next steps:'
echo '1. Open Chrome'
echo '2. Go to chrome://extensions/'
echo '3. Enable Developer Mode'  
echo '4. Click "Load unpacked"'
echo '5. Paste path: \\wsl$\Ubuntu\home\tbarthen\docbot'
