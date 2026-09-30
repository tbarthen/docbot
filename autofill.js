// DocBot auto-fill module: detects form fields and fills them with test data.
// Injected before content.js; guarded so re-injection is harmless.

if (typeof AutoFill === 'undefined') {
  window.AutoFill = {
    testData: {
      firstName: ['John', 'Jane', 'Michael', 'Sarah', 'David', 'Emily', 'Robert', 'Jennifer'],
      lastName: ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'],
      email: (first, last) => `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      phone: () => `(555) ${Math.floor(Math.random() * 900) + 100}-${Math.floor(Math.random() * 9000) + 1000}`,
      address: ['123 Main Street', '456 Oak Avenue', '789 Pine Road', '321 Elm Boulevard'],
      city: ['Springfield', 'Franklin', 'Clinton', 'Madison', 'Georgetown'],
      state: ['CA', 'NY', 'TX', 'FL', 'IL', 'PA', 'OH', 'MI', 'GA', 'NC'],
      zip: () => String(Math.floor(Math.random() * 90000) + 10000),
      company: ['Acme Corp', 'Global Industries', 'Tech Solutions Inc', 'Premier Services'],
      ssn: () => `${Math.floor(Math.random() * 900) + 100}-${Math.floor(Math.random() * 90) + 10}-${Math.floor(Math.random() * 9000) + 1000}`,
      date: () => {
        const year = 1950 + Math.floor(Math.random() * 50);
        const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
        const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
        return `${month}/${day}/${year}`;
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
        const label = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (label) return label.textContent;
      }
      const parentLabel = field.closest('label');
      return parentLabel ? parentLabel.textContent : '';
    },

    generateTestData(fieldType) {
      const data = this.testData;
      const random = (arr) => arr[Math.floor(Math.random() * arr.length)];
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

    fillField(field) {
      if (field.disabled || field.readOnly || field.type === 'password' || field.type === 'file') return false;
      if (field.value && field.value.trim() !== '') return false; // never overwrite existing data
      if ((field.type === 'checkbox' || field.type === 'radio') && field.checked) return false;

      if (field.tagName === 'SELECT') {
        const options = Array.from(field.options).filter((opt) => opt.value !== '');
        if (options.length === 0) return false;
        field.value = options[Math.floor(Math.random() * options.length)].value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (field.type === 'checkbox') {
        field.checked = Math.random() > 0.5;
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (field.type === 'radio') {
        const group = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(field.name)}"]`);
        if (group.length === 0) return false;
        group[Math.floor(Math.random() * group.length)].checked = true;
        return true;
      }
      field.value = this.generateTestData(this.detectFieldType(field));
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },

    isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.top < -1000 || rect.left < -1000) return false;
      for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const ps = window.getComputedStyle(parent);
        if (ps.display === 'none' || ps.visibility === 'hidden' || parseFloat(ps.opacity) === 0) return false;
      }
      return true;
    },

    findFillableFields() {
      const skip = new Set(['hidden', 'submit', 'button', 'password', 'file', 'reset', 'image']);
      return Array.from(document.querySelectorAll('input, select, textarea'))
        .filter((el) => !skip.has(el.type) && this.isVisible(el));
    },

    fillAllFields() {
      const fields = this.findFillableFields();
      let filled = 0;
      for (const field of fields) {
        if (this.fillField(field)) filled++;
      }
      return { total: fields.length, filled };
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
    }
  };
}
