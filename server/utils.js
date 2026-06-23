const roomPatterns = [
  { name: "Stairs & Landing - Boiler Cupboard", keywords: ["stairs and landing boiler cupboard", "stairs & landing boiler cupboard", "stairs and landing boiler cup'd", "stairs & landing boiler cup'd", "stairs and landing boiler cup", "stairs & landing boiler cup"] },
  { name: "Stairs and Landing", keywords: ["stairs and landing", "stairs & landing", "stairs/landing"] },
  { name: "Boiler Cupboard", keywords: ["boiler cupboard", "boiler cup'd", "boiler cupboard/store", "boiler cupboard / store", "boiler cup", "boiler cupd"] },
  { name: "Lounge", keywords: ["lounge", "living room", "sitting room", "reception room", "reception"] },
  { name: "Kitchen/Diner", keywords: ["kitchen/diner", "kitchen & diner", "kitchen diner"] },
  { name: "Kitchen", keywords: ["kitchen"] },
  { name: "Dining Room", keywords: ["dining room", "dining"] },
  { name: "Bedroom 1", keywords: ["bedroom 1", "bed 1", "master bedroom"] },
  { name: "Bedroom 2", keywords: ["bedroom 2", "bed 2"] },
  { name: "Bedroom 3", keywords: ["bedroom 3", "bed 3"] },
  { name: "Bedroom 4", keywords: ["bedroom 4", "bed 4"] },
  { name: "Bedroom", keywords: ["bedroom"] },
  { name: "Bathroom", keywords: ["bathroom", "bath room"] },
  { name: "Ensuite", keywords: ["ensuite", "en-suite", "en suite"] },
  { name: "WC", keywords: ["wc", "cloakroom", "toilet"] },
  { name: "Entrance Hall", keywords: ["entrance hall", "hallway", "hall", "lobby"] },
  { name: "Landing", keywords: ["landing"] },
  { name: "Utility Room", keywords: ["utility room", "utility"] },
  { name: "Store", keywords: ["store room", "store", "cupboard", "walk-in cupboard"] },
  { name: "Garage", keywords: ["garage"] },
  { name: "Garden", keywords: ["garden", "patio", "backyard", "yard"] },
  { name: "External", keywords: ["external works", "external", "roof", "chimney", "elevation", "outside", "outbuilding"] }
];

function isInformationalOnly(descLower) {
  const specIndicators = [
    'all materials shall be',
    'workmanship',
    'in compliance with',
    'found to be faulty',
    'replaced like for like',
    'shall be of approved',
    'shall be used for making good',
    'maker\'s instructions',
    'manufacturer\'s instructions',
    'manufacturers instructions',
    'general workmanship',
    'workmanship shall',
    'specification of materials',
    'for information only',
    'putty to bs',
    'bitumastic solution',
    'shall be in accordance',
    'to be in accordance with bs',
    'standard standards',
    'evidence of registration',
    'ce marked in accordance',
    'will be supplied by',
    'materials shall be',
    'is to be dulux',
    'paint for internal',
    'maker\'s name',
    'makers name',
    'sealed containers',
    'pink primer',
    'sadolin',
    'bitumastic shall be',
    'putty for woodwork'
  ];

  for (const indicator of specIndicators) {
    if (descLower.includes(indicator)) {
      return true;
    }
  }

  if (descLower.includes('electrical works') && descLower.includes('in accordance')) {
    return true;
  }
  if (descLower.includes('paint for internal') && descLower.includes('dulux')) {
    return true;
  }

  return false;
}

function normalizeDescription(description, section) {
  if (!description) return '';
  let clean = description.toLowerCase().trim();

  if (section) {
    const secLower = section.toLowerCase().trim();
    if (secLower && secLower !== 'general' && secLower !== 'unspecified') {
      if (clean.startsWith(secLower)) {
        clean = clean.substring(secLower.length).trim();
      }
      clean = clean.replace(/^[-\s:;,]+/g, '').trim();
    }
  }

  const roomPrefixes = [
    'lounge', 'kitchen', 'hall', 'stairs', 'landing', 'bedroom', 'bathroom',
    'sitting room', 'living room', 'dining room', 'wc', 'toilet', 'cupboard',
    'boiler cupboard', 'garden', 'front garden', 'rear garden', 'external',
    'externals', 'stairs and landing', 'entrance hall'
  ];
  for (const prefix of roomPrefixes) {
    if (clean.startsWith(prefix)) {
      let temp = clean.substring(prefix.length).trim();
      temp = temp.replace(/^[-\s:;,]+/g, '').trim();
      if (temp.length > 3) {
        clean = temp;
      }
    }
  }

  clean = clean.replace(/[.,;:()\-]+/g, ' ');
  clean = clean.replace(/\s+/g, ' ').trim();

  return clean;
}

function extractRoomFromDescription(description, currentSection) {
  if (!description) return { room: currentSection || 'General', description: '' };

  const originalDesc = description.trim();
  const descLower = originalDesc.toLowerCase();

  // 1. Check if the description starts with a known room name pattern
  for (const pattern of roomPatterns) {
    for (const kw of pattern.keywords) {
      const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp('^' + escapedKw + '\\b', 'i');
      if (regex.test(descLower)) {
        let rest = originalDesc.substring(kw.length).trim();
        rest = rest.replace(/^[:\-\s,]+/, '').trim();
        if (rest) {
          rest = rest.charAt(0).toUpperCase() + rest.slice(1);
        } else {
          rest = originalDesc;
        }
        return { room: pattern.name, description: rest };
      }
    }
  }

  // 2. Fallback to check if a prefix like "Lounge - Paint Ceiling" exists with colon/hyphen
  const prefixMatch = originalDesc.match(/^([a-zA-Z0-9\s&\/]+?)\s*[:\-]\s*(.*)$/);
  if (prefixMatch) {
    const potentialRoom = prefixMatch[1].trim();
    const rest = prefixMatch[2].trim();
    if (potentialRoom.split(/\s+/).length <= 3 && potentialRoom.length > 2 && potentialRoom.length < 30) {
      let roomMatched = null;
      for (const pattern of roomPatterns) {
        if (pattern.keywords.some(kw => potentialRoom.toLowerCase() === kw || potentialRoom.toLowerCase().includes(kw))) {
          roomMatched = pattern.name;
          break;
        }
      }
      if (roomMatched) {
        return { room: roomMatched, description: rest };
      }

      const lowerPot = potentialRoom.toLowerCase();
      const elementKeywords = [
        'ceiling', 'wall', 'floor', 'window', 'door', 'woodwork', 'radiator', 'fireplace',
        'additional', 'unit', 'appliance', 'skirting', 'lighting', 'light', 'plaster',
        'paint', 'decorat', 'services', 'demolition', 'groundwork', 'superstructure',
        'substructure', 'roof', 'chimney', 'electrical', 'plumbing', 'heating', 'carpentry',
        'masonry', 'brickwork', 'spec', 'note', 'general', 'other'
      ];
      const isElement = elementKeywords.some(kw => lowerPot.includes(kw));
      if (!isElement) {
        return { room: potentialRoom.charAt(0).toUpperCase() + potentialRoom.slice(1).toLowerCase(), description: rest };
      }
    }
  }

  // 3. Check if description contains any of the room keywords in the first 40 characters
  const isGenericSection = !currentSection ||
    ['general', 'unspecified', 'unknown', 'sheet1', 'checklist', 'worksheet', 'estimation'].includes(currentSection.toLowerCase().trim());

  if (isGenericSection) {
    for (const pattern of roomPatterns) {
      for (const kw of pattern.keywords) {
        const idx = descLower.indexOf(kw);
        if (idx !== -1 && idx < 40) {
          return { room: pattern.name, description: originalDesc };
        }
      }
    }
  }

  return { room: currentSection || 'General', description: originalDesc };
}

module.exports = {
  isInformationalOnly,
  normalizeDescription,
  extractRoomFromDescription
};
