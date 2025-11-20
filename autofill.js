// DocBot Auto-Fill Module
// Intelligent form field detection and filling with realistic test data

// Prevent re-declaration if already loaded
if (typeof AutoFill !== 'undefined') {
  console.log('DocBot: AutoFill already loaded, skipping re-initialization');
} else {
  window.AutoFill = {
  // Test data generators
  testData: {
    realistic: {
      firstName: ['John', 'Jane', 'Michael', 'Sarah', 'David', 'Emily', 'Robert', 'Jennifer'],
      lastName: ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'],
      email: (first, last) => `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      phone: () => `(555) ${String(Math.floor(Math.random() * 900) + 100)}-${String(Math.floor(Math.random() * 9000) + 1000)}`,
      address: ['123 Main Street', '456 Oak Avenue', '789 Pine Road', '321 Elm Boulevard'],
      city: ['Springfield', 'Franklin', 'Clinton', 'Madison', 'Georgetown'],
      state: ['CA', 'NY', 'TX', 'FL', 'IL', 'PA', 'OH', 'MI', 'GA', 'NC'],
      zip: () => String(Math.floor(Math.random() * 90000) + 10000),
      company: ['Acme Corp', 'Global Industries', 'Tech Solutions Inc', 'Premier Services'],
      ssn: () => `${String(Math.floor(Math.random() * 900) + 100)}-${String(Math.floor(Math.random() * 90) + 10)}-${String(Math.floor(Math.random() * 9000) + 1000)}`,
      date: () => {
        const year = 1950 + Math.floor(Math.random() * 50);
        const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
        const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
        return `${month}/${day}/${year}`;
      }
    }
  },

  patterns: {
    firstName: /first.*name|fname|given.*name/i,
    lastName: /last.*name|lname|surname|family.*name/i,
    fullName: /^name$|full.*name|customer.*name/i,
    email: /email|e-mail/i,
    phone: /phone|telephone|mobile|cell/i,
    address: /address.*line.*1|street.*address|address$/i,
    address2: /address.*line.*2|apt|suite|unit/i,
    city: /city|town/i,
    state: /state|province|region/i,
    zip: /zip|postal.*code|postcode/i,
    country: /country/i,
    company: /company|organization|employer/i,
    ssn: /ssn|social.*security/i,
    dob: /birth|dob|birthday/i
  },

  detectFieldType(field) {
    const identifiers = [
      field.name || '',
      field.id || '',
      field.placeholder || '',
      field.getAttribute('aria-label') || '',
      this.getFieldLabel(field)
    ].join(' ').toLowerCase();

    for (const [type, pattern] of Object.entries(this.patterns)) {
      if (pattern.test(identifiers)) return type;
    }
    if (field.type === 'email') return 'email';
    if (field.type === 'tel') return 'phone';
    if (field.type === 'date') return 'dob';
    return 'text';
  },

  getFieldLabel(field) {
    if (field.id) {
      const label = document.querySelector(`label[for="${field.id}"]`);
      if (label) return label.textContent;
    }
    const parentLabel = field.closest('label');
    if (parentLabel) return parentLabel.textContent;
    return '';
  },

  generateTestData(fieldType, useRealistic = true) {
    const data = this.testData.realistic;
    const random = arr => arr[Math.floor(Math.random() * arr.length)];

    switch (fieldType) {
      case 'firstName': return random(data.firstName);
      case 'lastName': return random(data.lastName);
      case 'fullName': return `${random(data.firstName)} ${random(data.lastName)}`;
      case 'email': return data.email(random(data.firstName), random(data.lastName));
      case 'phone': return data.phone();
      case 'address': return random(data.address);
      case 'address2': return Math.random() > 0.5 ? 'Apt 4B' : '';
      case 'city': return random(data.city);
      case 'state': return random(data.state);
      case 'zip': return data.zip();
      case 'country': return 'United States';
      case 'company': return random(data.company);
      case 'ssn': return data.ssn();
      case 'dob': return data.date();
      default: return 'Test Data';
    }
  },

  fillField(field, useRealistic = true) {
    if (field.disabled || field.readOnly || field.type === 'password' || field.type === 'file') return false;

    // Skip fields that already have values (don't overwrite existing data)
    if (field.value && field.value.trim() !== '') {
      return false;
    }

    // For checkboxes and radios, skip if already checked
    if ((field.type === 'checkbox' || field.type === 'radio') && field.checked) {
      return false;
    }

    const fieldType = this.detectFieldType(field);
    if (field.tagName === 'SELECT') {
      const options = Array.from(field.options).filter(opt => opt.value && opt.value !== '');
      if (options.length > 0) {
        field.value = options[Math.floor(Math.random() * options.length)].value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    } else if (field.type === 'checkbox') {
      field.checked = Math.random() > 0.5;
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } else if (field.type === 'radio') {
      const radioGroup = document.querySelectorAll(`input[type="radio"][name="${field.name}"]`);
      if (radioGroup.length > 0) {
        radioGroup[Math.floor(Math.random() * radioGroup.length)].checked = true;
        return true;
      }
    } else {
      field.value = this.generateTestData(fieldType, useRealistic);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  },

  findFillableFields() {
    const fields = [];
    const elements = document.querySelectorAll('input, select, textarea');
    elements.forEach(el => {
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'password' || el.type === 'file') return;

      // Check if element is actually visible
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (parseFloat(style.opacity) === 0) return;

      // Check dimensions
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      // Check if positioned off-screen
      if (rect.top < -1000 || rect.left < -1000) return;

      // Check if any parent is hidden
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        const parentStyle = window.getComputedStyle(parent);
        if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') return;
        if (parseFloat(parentStyle.opacity) === 0) return;
        parent = parent.parentElement;
      }

      fields.push(el);
    });
    return fields;
  },

  fillAllFields(useRealistic = true, delay = 200) {
    const fields = this.findFillableFields();

    // Fill fields immediately for accurate count
    let filledCount = 0;
    fields.forEach((field, index) => {
      // Add delay for visual stagger effect
      setTimeout(() => {
        this.highlightField(field);
      }, index * delay);

      // Fill immediately to get accurate count
      if (this.fillField(field, useRealistic)) {
        filledCount++;
      }
    });

    return { total: fields.length, filled: filledCount };
  },

  highlightField(field) {
    const originalBorder = field.style.border;
    const originalBackground = field.style.backgroundColor;
    field.style.border = '2px solid #667eea';
    field.style.backgroundColor = '#f0f3ff';
    setTimeout(() => {
      field.style.border = originalBorder;
      field.style.backgroundColor = originalBackground;
    }, 500);
  },

  findSubmitButtons() {
    const buttons = [];
    const submitInputs = document.querySelectorAll('input[type="submit"], button[type="submit"]');
    buttons.push(...submitInputs);
    const allButtons = document.querySelectorAll('button, input[type="button"]');
    allButtons.forEach(btn => {
      const text = (btn.textContent || btn.value || '').toLowerCase();
      if ((text.includes('submit') || text.includes('continue') || text.includes('next') ||
           text.includes('enroll') || text.includes('register')) && !buttons.includes(btn)) {
        buttons.push(btn);
      }
    });
    return buttons;
  }
  };
}
