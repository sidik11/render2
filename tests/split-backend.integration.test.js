'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const render1Root = path.resolve(__dirname, '..', '..', 'render1');
const render2Root = path.resolve(__dirname, '..');
const render1Entry = path.join(render1Root, 'server.js');
const render2Entry = path.join(render2Root, 'server.js');
let diagnosticLogs = () => '';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

function adminCookie(secret) {
  const payload = Buffer.from(JSON.stringify({
    uid: 'admin-cem-master',
    email: 'mjdeveloperodisha@gmail.com',
    exp: Date.now() + 60 * 60 * 1000
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return 'cem_admin_session=' + encodeURIComponent('ADM1.' + payload + '.' + signature);
}

function startService(entry, cwd, env) {
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-12000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-12000); });
  child.auditLogs = () => logs;
  return child;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 25000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Backend exited before health check. Logs:\n' + child.auditLogs());
    try {
      const response = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = 'HTTP ' + response.status;
    } catch (error) {
      lastError = String(error.message || error);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Backend health check timed out (' + lastError + '). Logs:\n' + child.auditLogs());
}

async function call(base, endpoint, { method = 'GET', body, cookie = '', portal = 'student' } = {}) {
  const headers = { Accept: 'application/json', 'X-CEM-Portal': portal };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  let response;
  try {
    response = await fetch(base + endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    throw new Error('Request failed: ' + method + ' ' + endpoint + ': ' + String(error.message || error) + '\\n' + diagnosticLogs());
  }
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, headers: response.headers };
}

function requireStatus(response, expected, label) {
  assert.equal(response.status, expected, label + ' failed: ' + JSON.stringify(response.data));
}

function userCookie(response) {
  const header = response.headers.get('set-cookie') || '';
  const match = header.match(/cem_user_session=([^;]+)/);
  assert.ok(match, 'login did not set the student/teacher session cookie: ' + header);
  return 'cem_user_session=' + match[1];
}

test('split backend registration, approval, Premium, image questions, timed submission, results and concurrent requests', { timeout: 90000 }, async t => {
  const port1 = await freePort();
  let port2 = await freePort();
  while (port2 === port1) port2 = await freePort();
  const base1 = 'http://127.0.0.1:' + port1;
  const base2 = 'http://127.0.0.1:' + port2;
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const internalSecret = crypto.randomBytes(32).toString('hex');
  const sharedEnv = {
    ...process.env,
    NODE_ENV: 'test',
    AUTH_SESSION_SECRET: sessionSecret,
    INTERNAL_AUTH_SECRET: internalSecret,
    FRONTEND_ORIGIN: base1,
    GMAIL_CLIENT_ID: '',
    GMAIL_CLIENT_SECRET: '',
    GMAIL_REFRESH_TOKEN: '',
    GMAIL_REDIRECT_URI: '',
    GMAIL_SENDER_EMAIL: '',
    SERVER1_FIREBASE_PROJECT_ID: '',
    SERVER1_FIREBASE_CLIENT_EMAIL: '',
    SERVER1_FIREBASE_PRIVATE_KEY: '',
    SERVER1_FIREBASE_DATABASE_URL: '',
    SERVER2_FIREBASE_PROJECT_ID: '',
    SERVER2_FIREBASE_CLIENT_EMAIL: '',
    SERVER2_FIREBASE_PRIVATE_KEY: '',
    SERVER2_FIREBASE_DATABASE_URL: '',
    KEEPALIVE_MS: '600000'
  };
  const server1 = startService(render1Entry, render1Root, {
    ...sharedEnv, PORT: String(port1), SERVER1_PORT: String(port1), SERVER2_URL: base2
  });
  const server2 = startService(render2Entry, render2Root, {
    ...sharedEnv, PORT: String(port2), SERVER2_PORT: String(port2), SERVER1_URL: base1
  });
  diagnosticLogs = () => 'Server1 logs: ' + server1.auditLogs() + ' Server2 logs: ' + server2.auditLogs();
  t.after(async () => {
    for (const child of [server2, server1]) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await Promise.all([server1, server2].map(child => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    })));
  });

  await Promise.all([waitForHealth(base1, server1), waitForHealth(base2, server2)]);
  const admin = adminCookie(sessionSecret);

  const moduleName = 'E2E Module ' + Date.now();
  const moduleResponse = await call(base1, '/api/modules', {
    method: 'POST', portal: 'admin', cookie: admin,
    body: { name: moduleName, description: 'Automated integration module' }
  });
  requireStatus(moduleResponse, 200, 'create module');
  const moduleId = moduleResponse.data.module.id;

  const planName = 'E2E Premium ' + Date.now();
  const planResponse = await call(base1, '/api/plans', {
    method: 'POST', portal: 'admin', cookie: admin,
    body: { name: planName, days: 30, price: 49 }
  });
  requireStatus(planResponse, 200, 'create Premium plan');
  const plan = planResponse.data.plans.find(item => item.name === planName);
  assert.ok(plan, 'created plan missing from API response');

  const teacherEmail = 'teacher-' + Date.now() + '@example.test';
  const teacherRegistration = await call(base1, '/api/auth/register/teacher', {
    method: 'POST',
    body: { name: 'E2E Teacher', email: teacherEmail, mobile: '9876543210', subject: 'Mathematics', password: 'TeacherPass123' }
  });
  requireStatus(teacherRegistration, 200, 'teacher registration');
  const teacherId = teacherRegistration.data.user.uid;
  const blockedTeacherLogin = await call(base1, '/api/auth/login', {
    method: 'POST', body: { email: teacherEmail, password: 'TeacherPass123' }
  });
  requireStatus(blockedTeacherLogin, 403, 'pending teacher login');
  const approveTeacher = await call(base1, '/api/admin/teachers/' + encodeURIComponent(teacherId) + '/approve', {
    method: 'POST', portal: 'admin', cookie: admin, body: { approved: true }
  });
  requireStatus(approveTeacher, 200, 'approve teacher');
  const teacherLogin = await call(base1, '/api/auth/login', {
    method: 'POST', body: { email: teacherEmail, password: 'TeacherPass123' }
  });
  requireStatus(teacherLogin, 200, 'approved teacher login');
  const teacher = userCookie(teacherLogin);

  const questionImage = 'data:image/jpeg;base64,/9j/2Q==';
  const testResponse = await call(base1, '/exam-api/api/tests', {
    method: 'POST', portal: 'student', cookie: teacher,
    body: {
      title: 'E2E Premium Image Test',
      exam: 'Integration',
      category: moduleName,
      subjects: ['Mathematics'],
      sectionQuestionCounts: { Mathematics: 1 },
      languages: ['English'],
      type: 'PAID',
      duration: 2,
      attemptPolicy: 'reattempt',
      questions: [{
        question: '2 + 2 = ?',
        options: ['3', '4', '5', '6'],
        answer: 'B',
        subject: 'Mathematics',
        marks: 1,
        negative: 0,
        imageDataUrl: questionImage,
        instructions: 'Choose one answer.'
      }]
    }
  });
  requireStatus(testResponse, 200, 'teacher creates paid test with image');
  const exam = testResponse.data.test;
  assert.ok(exam.id, 'test id missing');

  const studentEmail = 'student-' + Date.now() + '@example.test';
  const studentRegistration = await call(base1, '/api/auth/register/student', {
    method: 'POST',
    body: { name: 'E2E Student', email: studentEmail, mobile: '9876543211', password: 'StudentPass123' }
  });
  requireStatus(studentRegistration, 200, 'student registration');
  const studentLogin = await call(base1, '/api/auth/login', {
    method: 'POST', body: { email: studentEmail, password: 'StudentPass123' }
  });
  requireStatus(studentLogin, 200, 'student login');
  const student = userCookie(studentLogin);

  const beforePremium = await call(base1, '/exam-api/api/tests/' + encodeURIComponent(exam.id), { cookie: student });
  assert.equal(beforePremium.status, 403, 'non-Premium student must receive a forbidden response');
  assert.match(String(beforePremium.data.error || ''), /Premium/i, 'expected Premium access denial');

  const subscriptionRequest = await call(base1, '/api/subscription/request', {
    method: 'POST', cookie: student,
    body: { planId: plan.id, txnId: 'E2EUTR' + Date.now() }
  });
  requireStatus(subscriptionRequest, 200, 'submit subscription request');
  const subscriptionId = subscriptionRequest.data.subscription.id;
  const approveSubscription = await call(base1, '/api/subscription/' + encodeURIComponent(subscriptionId) + '/decide', {
    method: 'POST', portal: 'admin', cookie: admin, body: { approved: true }
  });
  requireStatus(approveSubscription, 200, 'approve subscription');
  assert.ok(Date.parse(approveSubscription.data.subscription.expiresAt) > Date.now(), 'Premium expiry must be in the future');

  const afterPremium = await call(base1, '/exam-api/api/tests/' + encodeURIComponent(exam.id), { cookie: student });
  requireStatus(afterPremium, 200, 'Premium student opens paid test');
  const started = await call(base1, '/exam-api/api/tests/' + encodeURIComponent(exam.id) + '/start', {
    method: 'POST', cookie: student, body: {}
  });
  requireStatus(started, 200, 'start timed exam');
  assert.equal(started.data.questions[0].imageDataUrl, questionImage, 'question image must reach the exam client');
  const durationMs = Date.parse(started.data.serverExpiresAt) - Date.parse(started.data.serverStartedAt);
  assert.ok(durationMs >= 60000 && durationMs <= 120000 + 1000, 'server-side exam duration is outside expected bounds');

  const submitBody = {
    attemptId: started.data.attemptId,
    answers: { 0: 'B' },
    timeBySubject: { Mathematics: 12 }
  };
  const concurrent = await Promise.all([
    call(base1, '/exam-api/api/tests/' + encodeURIComponent(exam.id) + '/submit', { method: 'POST', cookie: student, body: submitBody }),
    call(base1, '/exam-api/api/tests/' + encodeURIComponent(exam.id) + '/submit', { method: 'POST', cookie: student, body: submitBody })
  ]);
  assert.ok(concurrent.some(result => result.status === 200), 'at least one concurrent submission must succeed: ' + JSON.stringify(concurrent.map(x => ({status:x.status,data:x.data}))));
  assert.ok(concurrent.every(result => result.status === 200 || result.status === 409), 'unexpected concurrent submit status: ' + JSON.stringify(concurrent.map(x => x.status)));
  const finalResult = await call(base1, '/exam-api/api/tests/' + encodeURIComponent(exam.id) + '/submit', {
    method: 'POST', cookie: student, body: submitBody
  });
  requireStatus(finalResult, 200, 'idempotent submission retry');
  assert.equal(finalResult.data.score, 1, 'server must calculate the expected score');
  assert.equal(finalResult.data.correct, 1);
  assert.equal(finalResult.data.total, 1);
  assert.ok(finalResult.data.submissionId, 'submission result id missing');

  const secondEmail = 'buyer-' + Date.now() + '@example.test';
  const secondRegistration = await call(base1, '/api/auth/register/student', {
    method: 'POST',
    body: { name: 'E2E Buyer', email: secondEmail, mobile: '9876543212', password: 'BuyerPass123' }
  });
  requireStatus(secondRegistration, 200, 'second student registration');
  const secondLogin = await call(base1, '/api/auth/login', {
    method: 'POST', body: { email: secondEmail, password: 'BuyerPass123' }
  });
  requireStatus(secondLogin, 200, 'second student login');
  const buyer = userCookie(secondLogin);
  const purchaseRequest = await call(base1, '/api/purchases/request', {
    method: 'POST', cookie: buyer, body: { testId: exam.id }
  });
  requireStatus(purchaseRequest, 200, 'per-test purchase request resolves Server 2 test');
  const purchaseId = purchaseRequest.data.purchase.id;
  const approvePurchase = await call(base1, '/api/purchases/' + encodeURIComponent(purchaseId) + '/decide', {
    method: 'POST', portal: 'admin', cookie: admin, body: { approved: true }
  });
  requireStatus(approvePurchase, 200, 'approve per-test purchase');
  const purchasedAccess = await call(base1, '/exam-api/api/tests/' + encodeURIComponent(exam.id), { cookie: buyer });
  requireStatus(purchasedAccess, 200, 'Server 2 recognizes approved Server 1 purchase');

  const deleteModule = await call(base1, '/api/modules/' + encodeURIComponent(moduleId), {
    method: 'DELETE', portal: 'admin', cookie: admin
  });
  requireStatus(deleteModule, 200, 'delete module across both servers');
  const deletedTest = await call(base1, '/exam-api/api/tests/' + encodeURIComponent(exam.id), { cookie: student });
  assert.notEqual(deletedTest.status, 200, 'deleting a module must also remove its test series from Server 2');
});
