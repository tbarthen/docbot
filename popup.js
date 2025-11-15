document.getElementById('startBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({action: 'startRecording', settings: {}});
});