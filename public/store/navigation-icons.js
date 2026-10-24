const filled={
  menu:'<rect x="3" y="4" width="18" height="3" rx="1.5"/><rect x="3" y="10.5" width="18" height="3" rx="1.5"/><rect x="3" y="17" width="18" height="3" rx="1.5"/>',
  home:'<path d="M2 10.5 12 2l10 8.5-1.9 2.2-1.1-.9V22h-5v-7h-4v7H5V11.8l-1.1.9z"/>',
  catalog:'<rect x="2" y="2" width="8" height="8" rx="1.5"/><rect x="14" y="2" width="8" height="8" rx="1.5"/><rect x="2" y="14" width="8" height="8" rx="1.5"/><rect x="14" y="14" width="8" height="8" rx="1.5"/>',
  offers:'<defs><mask id="ft-offers-solid"><rect width="24" height="24" fill="white"/><circle cx="6" cy="6" r="1.3" fill="black"/><circle cx="10" cy="11" r="1.2" fill="black"/><circle cx="15" cy="16" r="1.2" fill="black"/><path d="m15.5 10-6 7" stroke="black" stroke-width="1.8"/></mask></defs><path d="M2 3a1 1 0 0 1 1-1h8a2 2 0 0 1 1.4.6l9 9a2 2 0 0 1 0 2.8l-7 7a2 2 0 0 1-2.8 0l-9-9A2 2 0 0 1 2 11z" mask="url(#ft-offers-solid)"/>',
  cart:'<path d="M1 2h3a1 1 0 0 1 1 .8L5.5 5H22l-2.2 9a2 2 0 0 1-2 1.5H7.8l.3 1.5H20v2H7a1 1 0 0 1-1-.8L3.2 4H1z"/><circle cx="8" cy="21" r="1.8"/><circle cx="18" cy="21" r="1.8"/>'
};
export function navigationIcon(route,outline){
  return `<span class="ft-nav-icon ft-nav-icon--outline">${outline}</span><svg class="ft-nav-icon ft-nav-icon--filled" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${filled[route]||''}</svg>`;
}
