// AAC (ISO/IEC 14496-3) fixed tables for the HDC core: Huffman codebooks, 22050 Hz band offsets, windows, TNS limits.

// Codebook values from the standard, as '<lengths, char 64+len>|<codes, base36>': scalefactor, then spectral 1-11.
const BOOKS = [
  'RRRRSSSSSSSSSSSSSSSRSRQQPQPPPPOONNNNNNMMLLLKLKJJJIIHHHGFFEDCADDEFFGGHHIIJJJKKKKLLMMMNNPOPORSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS|5m94,5m92,5m93,5m91,b8j9,b8j5,b8j1,b8ja,b8j2,b8j3,b8j4,b8jg,b8jh,b8jj,b8ji,b8jb,b8jc,b8jf,b8jd,5m90,b8je,5m8z,2t4f,2t4g,1ek5,2t4e,1ek2,1ek3,1ek4,1ek1,p9y,p9z,cmx,cmt,cmv,cmr,cmu,cmq,6bb,6b9,35l,35j,35i,1kp,35g,1ko,s9,s7,s5,e0,dz,6y,6w,6u,3d,1m,1k,q,b,4,0,a,c,r,1l,1n,3c,3e,6v,6x,dy,e1,s4,s6,s8,1kl,1kk,1km,1kn,35h,35k,6b8,6ba,6bc,cmw,cms,1ek0,p9w,1ek6,p9x,5m8y,b8ih,b8ii,b8ij,b8ik,b8il,b8im,b8ig,b8ia,b8ib,b8ic,b8id,b8ie,b8j6,b8in,b8iv,b8iw,b8ix,b8iy,b8iz,b8iu,b8io,b8ip,b8iq,b8ir,b8is,b8it,b8if,b8j0,b8j8,b8j7',
  'KIKJGJKIKJGJGEGIGJKIKIGIKIKIGIGEGIGIGEGEAEGEGIGIGEGIGIKIKIGIKIKJGIGEGIGJKIKJGIKIK|1ko,dt,1kt,s5,2w,s0,1kn,do,1kl,s1,36,s4,38,h,3a,dn,30,s6,1ks,dd,1kh,ds,2p,dy,1ki,dm,1kr,du,2x,dp,3b,n,33,di,2s,dh,2v,l,2q,i,0,k,2t,m,31,dl,2r,dg,2z,j,35,df,34,dv,1ku,dj,1kj,dr,2o,dq,1kg,de,1kq,s3,2y,dk,39,g,37,dw,32,s7,1km,dc,1kp,s2,2u,dx,1kv,dz,1kk',
  'IGIHFHIHIHFGFEFGFHIGHHFHIGIHFGFEFGFHFEFECEFEFHFGFEFHFHIGIHFHHGIHFGFDFHFGIGIGFHIGI|dv,33,e5,6j,z,6i,dz,6g,e2,6q,19,34,w,6,17,32,14,6h,e1,2u,6w,6f,r,6p,dw,2z,dx,6k,16,30,18,a,13,2v,q,6t,10,8,v,9,0,7,t,b,1c,6n,s,2s,u,c,15,6r,1b,6o,e4,35,du,6s,x,6e,6v,2w,e0,6m,y,2t,1d,2,12,6l,11,2y,e3,36,e6,2x,1a,6u,e7,31,dy',
  'ADHDEHIIJDFIFFIIIJIJMIIKKJLDFJFGJJJLEGKFGJIIKIJMHILJKLHJOIKOMNPHJNIJNLLOKLPJKOLLO|0,9,6n,b,p,6o,dn,di,s2,a,1h,dr,1g,1j,dl,dp,dj,s3,dq,rx,6be,do,du,1kp,1ko,s8,35k,8,1k,s6,1i,39,s1,rv,rw,35g,o,3a,1kk,1l,38,rz,dv,dw,1km,dk,ru,6bg,6q,dt,35n,s5,1kj,35o,6m,s7,pa6,ds,1kl,pa5,6bf,cmy,1ekf,6p,s0,cn0,dm,ry,cmz,35i,35m,pa4,1ki,35h,1eke,s4,1kn,pa3,35j,35l,pa2',
  'DEHEDHIHKEEHEDHHGJIHKHHJKJKDEHDDHHHJDDHDDGHGIHHJGGIJIJHHKHGJKJLHGJGGIJIKKJLJIKKJK|7,m,6u,o,8,6n,dr,6r,1ko,p,n,6l,l,1,6a,6o,34,s0,dq,6p,1kq,6m,6c,s2,1km,rz,1kt,5,k,6q,9,4,6d,6s,6g,s4,6,2,6f,3,0,2z,6b,2x,dv,6j,6e,s6,32,2y,dw,rw,ds,s9,6t,6k,1kr,6i,33,s7,1kp,s3,35r,6h,31,s8,30,2w,dx,ry,du,1kk,1kn,s1,35q,rx,dt,1kl,1ku,s5,1ks',
  'MLKKJKKLMLKJIHIJKLLJIHGHIJKKIHEDEHIKJHGDADGHKKIHEDEHIKKJIHGHIJKLKJIHIJKLMLLKJJKLM|6bj,35j,1kk,1k8,s1,1ke,1kp,35k,6bh,35p,1kh,rs,dk,6o,do,ry,1ki,35m,35g,rz,du,6g,34,6k,ds,ru,1kj,1kb,dn,6i,q,8,p,6m,dr,1kd,s0,6q,37,b,0,a,35,6r,1k9,1kf,dq,6n,o,9,r,6j,dl,1kc,1km,rv,dv,6l,36,6h,dt,rx,1kn,35i,1kg,rt,dp,6p,dm,rw,1ko,35l,6bg,35o,35h,1ka,s3,s2,1kl,35n,6bi',
  'KJIIIIIJKJIHGGGHIJIHFFFFFHIIGFDDDFGIIGFDDDFGIIGFDDDFGIIHFFFFFHIJIHGGGGHJKJIIIIIJK|1ku,sd,dt,dn,dw,dm,ds,sc,1kt,s6,dh,6i,30,35,2w,6o,di,s7,dv,6n,1e,13,14,12,1d,6j,dz,dk,33,1a,8,4,6,15,2z,dq,dr,36,19,2,0,3,1b,37,e2,dj,32,17,7,1,5,18,31,do,e1,6m,1c,10,16,11,1f,6k,du,s8,dg,6l,2y,34,2x,38,6p,sa,1kv,s9,dy,dp,e0,dl,dx,sb,1ks',
  'ACFGHIJKCDFGHHIIFFGHHIIJGGHHIIJJHHIIJJJKIHIIJJKKJIIJJKLLKJJJKKLL|0,5,1j,38,6q,dn,rx,1kn,4,c,1h,35,6k,6m,dq,dx,1i,1g,36,6i,6p,dl,dv,s5,37,34,6j,6o,dt,ds,rw,sa,6r,6l,dk,dr,rz,s1,s9,1kr,dp,6n,dm,du,s3,s8,1kp,1ks,ry,do,dw,s4,s7,1ko,35p,35q,1km,s0,s2,s6,1kq,1kt,35o,35r',
  'EDEFGHIJDCDEFGGHEDDEFGGHFEEFFGHHGFFFGGHIHGFGGHHJIGGHHHIIJHHHIIIJ|e,5,g,1c,33,6p,e2,se,3,0,4,i,18,2y,39,6w,f,2,6,k,1a,2x,36,6t,1b,h,j,16,1e,30,6k,6y,35,17,19,1d,31,34,6q,e1,6n,2w,1f,2z,32,6m,6x,sc,e0,38,37,6l,6o,6u,dy,e5,sd,6r,6s,6v,dz,e3,e4,sf',
  'ACFHIJJKKLLMMCDFGHHIJJJKLLFFGHHIJJJKLLLHGHIIJJKKKLLMIHIIJJKKKLLLMJIIJKKKLKLLMMKIJKKKLLLLMMMKJJKKLLMMMMMMKJJKKKLLMMNMNKJKKLLLLMMNNNLKKLLLMMMNNNOLKLLLMMMMNNOOMLLLMMMMNNNNO|0,5,1j,6f,da,r2,rd,1jc,1jh,348,34t,6as,6b0,4,c,1h,36,6i,6l,de,r5,r7,rk,1js,34f,34l,1i,1g,35,6g,6k,dd,r3,rh,rf,1jk,347,34k,350,6e,34,6h,d9,df,r6,rg,1jg,1je,1jy,34o,356,6aj,db,6j,d8,di,r9,ri,1jf,1jx,1jw,34d,34y,353,6ap,r4,dc,dg,ra,1j9,1jl,1jv,34i,1k0,34p,357,6ar,6ax,1j8,dh,rb,1ja,1jj,1ju,34b,34q,34z,355,6au,6b7,6bb,1jn,rc,rl,1jo,1jt,34j,34u,6al,6ah,6aq,6ay,6b5,6ba,1jm,r8,re,1jb,1jr,1k2,34e,34r,6ag,6b2,cmo,6b8,cmq,1k1,rj,1jd,1jq,34a,34g,351,352,6az,6b3,cmr,cms,cmt,34w,1ji,1jp,346,34h,34x,6ao,6aw,6b4,cmp,cmw,cmu,pa4,354,1jz,349,34n,34s,6ak,6an,6b1,6b9,cmx,cmz,pa5,pa6,6av,34c,34m,34v,6am,6ai,6at,6b6,cmy,cmv,cn0,cn1,pa7',
  'FEFFGHIJJJKKLEDDEFGGHHIJJKFDEEFFGHHIIJJFEEEFGGHHIIJJGFFFFGGHHIIJJHGFGGGHHHIJJKIGGGGHHIIIJJKIHHHHHIIIJJKKIHHHHHIIJJJKKJIIIIIIJJJKKLJIIIIJJJJKKKLKJIJJJJJKKKKLKJJJJJJKKLLLL|y,8,t,12,2n,5v,cv,r4,rb,rx,1kg,1km,35p,7,0,1,9,w,2c,2o,5x,64,d0,r1,ri,1k7,s,2,6,c,u,14,2j,5p,61,cu,d8,rd,s1,11,b,a,d,10,2f,2p,5o,65,cs,da,r7,rr,2l,x,v,z,13,2h,2s,60,67,cy,de,rh,ry,5t,2d,15,2e,2g,2q,5q,68,6a,d6,r8,rn,1kb,cp,2m,2i,2k,2r,5m,62,cn,cq,dc,rf,rs,1kc,df,5u,5n,5s,5z,63,cm,d1,d4,qy,re,1ka,1kh,dd,5w,5r,5y,66,69,cw,d2,r5,r9,s2,1ke,1kr,rt,ct,co,cr,cx,d3,db,r3,rk,rz,1k6,1ko,35m,rv,d9,cz,d5,d7,r6,r0,rg,ru,1kd,1kj,1kp,35l,1ki,r2,dg,qz,rc,ra,rm,rp,1k8,1kk,1kl,1kn,35n,1kq,rw,rj,rl,ro,rq,s0,1k9,1kf,35k,35q,35o,35r',
  'DEFGHHIJJJKKLKLLJEDEFGGHHIIIJJJJKHFEEFGGHHHIIIJJJJHGFFFGGHHHIIIJJJJHHGGGGHHHHIIIJJJJHHGGGGHHHIIIIJJJJHIHHHHHHHIIIJJJJJHIHHHHHHIIIJJJJJJHJIHHIIIIIJJJJJJKHJIIIIIIIJJJJJJKKHKIIIIIIJJJJJKJKKHKJIIJIJJJJJKKKKKHKJJJJJJJJJJKKKKKIKJIIJJJJJJKKKKKKIKJJJJJJJJJKKKKKKILJJJJJJJKKKKKKLLIIHHHHHHHHHHHHHHIE|0,6,p,1p,4c,5i,br,pc,qq,rj,1k6,1kj,35n,1kc,35m,35q,pa,5,1,8,k,1j,1u,42,4v,b5,bp,c5,pq,qo,pu,r1,1jq,4u,n,7,9,o,1l,1s,3y,4j,54,bd,bw,ch,q9,pi,qm,qy,4d,1o,l,m,q,1n,1w,41,4l,5a,ba,by,c9,pt,pd,px,r9,44,4a,1i,1k,1m,1t,3w,4b,4w,5f,bi,bv,cc,pr,pb,q1,r3,43,5b,1q,1r,1v,1x,4e,4n,55,b8,bm,ca,cj,py,pz,qj,r8,4f,bk,3z,3x,40,48,4m,52,5g,bj,bz,cf,pl,qn,qc,qx,rr,4o,c6,4r,4k,4q,4y,5e,5h,bc,bo,c8,p8,pw,qs,qu,rh,rs,4t,q7,b6,59,58,b2,bb,be,bn,c1,p9,pk,qf,r7,r5,rf,1jx,50,ri,bt,bf,bg,bl,bu,bx,c3,p7,qa,qg,r2,rl,rk,1jm,1k5,53,1k3,cb,bs,bq,c0,c2,c7,pn,pm,qi,qd,ra,1jr,ro,1js,1ka,56,1k8,ps,cd,c4,p6,ck,pe,q2,q8,qk,rb,1jo,1jw,1jv,1jp,1kg,5d,1kr,qw,pv,ph,pp,q4,q6,qt,rc,rm,rq,1k4,1k7,1k0,1k9,1kn,b4,1ki,pf,ce,cg,pg,pj,q5,qr,qp,r6,1ju,1jt,1jz,1kb,1kk,1kq,b9,1ko,ql,po,q3,q0,qb,qh,r4,rn,rp,1k2,1jy,1kd,1kh,1kp,1ks,b7,35p,rg,qe,qv,r0,qz,rd,re,1jn,1k1,1ke,1kf,1kl,1km,35o,35r,bh,ci,51,4h,46,47,45,49,4g,4i,4s,4p,4x,4z,57,5c,b3,4',
];

export interface Huff { tree: Int32Array; count: number; lens: Uint8Array; codes: Uint32Array }

// Binary decode tree: node i has children at tree[2i], tree[2i+1]; >= 0 is a node index, < 0 is ~symbol.
function build(s: string): Huff {
  const [l, c] = s.split('|'), cs = c.split(',');
  const count = l.length, lens = new Uint8Array(count), codes = new Uint32Array(count);
  for (let i = 0; i < count; i++) { lens[i] = l.charCodeAt(i) - 64; codes[i] = parseInt(cs[i], 36); }
  const tree: number[] = [0, 0];
  let nodes = 1;
  for (let s = 0; s < count; s++) {
    let n = 0;
    for (let b = lens[s] - 1; b >= 0; b--) {
      const k = 2 * n + ((codes[s] >>> b) & 1);
      if (b === 0) { if (tree[k] !== 0) throw new Error('AAC codebook is not a prefix code'); tree[k] = ~s; break; }
      if (tree[k] < 0) throw new Error('AAC codebook is not a prefix code');
      if (tree[k] === 0) { tree[k] = nodes++; tree.push(0, 0); }
      n = tree[k];
    }
  }
  return { tree: Int32Array.from(tree), count, lens, codes };
}

// Index 0 is the scalefactor book, 1-11 the spectral books.
export const BOOK: Huff[] = BOOKS.map(build);

// Per spectral book 1-11: values per codeword, signed, largest magnitude (16 = escape in book 11).
export const BOOK_DIM = [0, 4, 4, 4, 4, 2, 2, 2, 2, 2, 2, 2];
export const BOOK_SIGNED = [false, true, true, false, false, true, true, false, false, false, false, false];
export const BOOK_LAV = [0, 1, 1, 2, 2, 4, 4, 7, 7, 12, 12, 16];
export const BOOK_COUNT = [121, 81, 81, 81, 81, 81, 81, 64, 64, 169, 169, 289];

// Scalefactor band offsets for sampling frequency index 7 (22050 Hz, shared with 24000 Hz).
export const SWB_LONG = Uint16Array.from([
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 52, 60, 68, 76, 84, 92, 100, 108, 116, 124, 136, 148,
  160, 172, 188, 204, 220, 240, 260, 284, 308, 336, 364, 396, 432, 468, 508, 552, 600, 652, 704, 768,
  832, 896, 960, 1024]);
export const SWB_SHORT = Uint16Array.from([0, 4, 8, 12, 16, 20, 24, 28, 36, 44, 52, 64, 76, 92, 108, 128]);
export const TNS_MAX_SFB_LONG = 46;
export const TNS_MAX_SFB_SHORT = 14;

function besselI0(x: number): number {
  let sum = 1, term = 1;
  for (let k = 1; k < 60; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < 1e-14 * sum) break; }
  return sum;
}

// Rising half of a window of total length n (n/2 values).
export function sineWindow(n: number): Float64Array {
  const w = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) w[i] = Math.sin(Math.PI / n * (i + 0.5));
  return w;
}

export function kbdWindow(n: number, alpha: number): Float64Array {
  const h = n / 2, k = new Float64Array(h + 1), w = new Float64Array(h);
  for (let i = 0; i <= h; i++) { const t = (i - n / 4) / (n / 4); k[i] = besselI0(Math.PI * alpha * Math.sqrt(Math.max(0, 1 - t * t))); }
  let total = 0; for (let i = 0; i <= h; i++) total += k[i];
  let acc = 0; for (let i = 0; i < h; i++) { acc += k[i]; w[i] = Math.sqrt(acc / total); }
  return w;
}

export const WIN_LONG = [sineWindow(2048), kbdWindow(2048, 4)];
export const WIN_SHORT = [sineWindow(256), kbdWindow(256, 6)];

// Self-check: every codebook complete (Kraft sum 1) with the right size, band tables and windows sane.
export function verifyTables(): string[] {
  const bad: string[] = [];
  BOOK.forEach((b, i) => {
    let kraft = 0; for (let s = 0; s < b.count; s++) kraft += 2 ** -b.lens[s];
    if (Math.abs(kraft - 1) > 1e-12) bad.push(`book ${i}: Kraft sum ${kraft}`);
    if (b.count !== BOOK_COUNT[i]) bad.push(`book ${i}: ${b.count} entries, want ${BOOK_COUNT[i]}`);
  });
  if (SWB_LONG.length !== 48 || SWB_LONG[47] !== 1024) bad.push('long band table');
  if (SWB_SHORT.length !== 16 || SWB_SHORT[15] !== 128) bad.push('short band table');
  for (const t of [SWB_LONG, SWB_SHORT]) for (let i = 1; i < t.length; i++) if (t[i] <= t[i - 1] || (t[i] - t[i - 1]) % 4) bad.push('band widths');
  for (const w of [...WIN_LONG, ...WIN_SHORT]) {
    const h = w.length;
    for (let i = 0; i < h; i++) if (Math.abs(w[i] ** 2 + w[h - 1 - i] ** 2 - 1) > 1e-9) { bad.push(`window ${2 * h} not power complementary`); break; }
  }
  return bad;
}
