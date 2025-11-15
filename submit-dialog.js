// DocBot Submit Confirmation Dialog
// Shows a pause dialog before form submission

const SubmitDialog = {
  dialogElement: null,
  overlayElement: null,
  resolveCallback: null,

  // Create and show the dialog
  show() {
    return new Promise((resolve) => {
      this.resolveCallback = resolve;
      this.create();
      this.attachEventListeners();
    });
  },

  // Create dialog HTML
  create() {
    // Create overlay
    this.overlayElement = document.createElement('div');
    this.overlayElement.id = 'docbot-submit-overlay';
    this.overlayElement.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      z-index: 999998;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: docbot-fade-in 0.2s ease;
    `;

    // Create dialog
    this.dialogElement = document.createElement('div');
    this.dialogElement.id = 'docbot-submit-dialog';
    this.dialogElement.style.cssText = `
      background: white;
      border-radius: 12px;
      padding: 30px;
      max-width: 500px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      animation: docbot-slide-up 0.3s ease;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    `;

    this.dialogElement.innerHTML = `
      <div style="text-align: center; margin-bottom: 20px;">
        <div style="font-size: 48px; margin-bottom: 10px;">⏸️</div>
        <h2 style="margin: 0 0 10px 0; color: #333; font-size: 24px;">Ready to Submit?</h2>
        <p style="margin: 0; color: #666; font-size: 14px;">DocBot has auto-filled the form. Review the data before proceeding.</p>
      </div>

      <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <p style="margin: 0 0 10px 0; font-size: 13px; color: #495057;">
          <strong>What would you like to do?</strong>
        </p>
        <ul style="margin: 0; padding-left: 20px; font-size: 13px; color: #6c757d;">
          <li>Review and edit any fields if needed</li>
          <li>Click "Continue" to proceed with submission</li>
          <li>Click "Cancel" to stop the auto-fill process</li>
        </ul>
      </div>

      <div style="display: flex; gap: 10px; justify-content: center;">
        <button id="docbot-dialog-cancel" style="
          flex: 1;
          padding: 12px 24px;
          border: 2px solid #6c757d;
          background: white;
          color: #6c757d;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        ">
          Cancel
        </button>
        <button id="docbot-dialog-continue" style="
          flex: 1;
          padding: 12px 24px;
          border: none;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        ">
          Continue
        </button>
      </div>

      <p style="margin: 20px 0 0 0; text-align: center; font-size: 11px; color: #adb5bd;">
        DocBot is still recording. This pause is for your review only.
      </p>
    `;

    // Add animations
    const style = document.createElement('style');
    style.textContent = `
      @keyframes docbot-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes docbot-slide-up {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      #docbot-dialog-cancel:hover {
        background: #f8f9fa;
        transform: translateY(-1px);
      }
      #docbot-dialog-continue:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
      }
    `;
    document.head.appendChild(style);

    this.overlayElement.appendChild(this.dialogElement);
    document.body.appendChild(this.overlayElement);
  },

  // Attach event listeners
  attachEventListeners() {
    const cancelBtn = document.getElementById('docbot-dialog-cancel');
    const continueBtn = document.getElementById('docbot-dialog-continue');

    cancelBtn.addEventListener('click', () => {
      this.close(false);
    });

    continueBtn.addEventListener('click', () => {
      this.close(true);
    });

    // Close on overlay click
    this.overlayElement.addEventListener('click', (e) => {
      if (e.target === this.overlayElement) {
        this.close(false);
      }
    });

    // Close on Escape key
    this.escapeHandler = (e) => {
      if (e.key === 'Escape') {
        this.close(false);
      }
    };
    document.addEventListener('keydown', this.escapeHandler);
  },

  // Close dialog and resolve promise
  close(shouldContinue) {
    // Remove event listener
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler);
    }

    // Fade out animation
    if (this.overlayElement) {
      this.overlayElement.style.animation = 'docbot-fade-in 0.2s ease reverse';
      setTimeout(() => {
        if (this.overlayElement && this.overlayElement.parentNode) {
          this.overlayElement.parentNode.removeChild(this.overlayElement);
        }
        this.overlayElement = null;
        this.dialogElement = null;
      }, 200);
    }

    // Resolve promise
    if (this.resolveCallback) {
      this.resolveCallback(shouldContinue);
      this.resolveCallback = null;
    }
  }
};

// Export for use in content script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SubmitDialog;
}
