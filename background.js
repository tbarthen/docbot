// DocBot Background Service Worker
let recordingData = {startTime: null, endTime: null, screenshots: [], actions: [], settings: {}};
let isRecording = false;
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startRecording') {
    isRecording = true;
    recordingData = {startTime: Date.now(), endTime: null, screenshots: [], actions: [], settings: message.settings || {}};
    chrome.storage.local.set({isRecording: true, recordingData});
    sendResponse({success: true});
  }
});