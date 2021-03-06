import { inspect } from 'util';
import * as judge from './judge';
import { ValidationError } from '../error';
import * as check from '../check';
import * as setting from '../model/setting';
import * as system from '../model/system';
import * as user from '../model/user';
import { STATUS, PRIV } from '../model/builtin';
import * as record from '../model/record';
import {
    Route, Connection, Handler, ConnectionHandler, param, Types,
} from '../service/server';
import {
    validate, isEmail, isUname, isPassword,
} from '../lib/validator';

function set(key, value) {
    if (setting.SYSTEM_SETTINGS_BY_KEY[key]) {
        const s = setting.SYSTEM_SETTINGS_BY_KEY[key];
        if (s.flag & setting.FLAG_DISABLED) return undefined;
        if (s.flag & setting.FLAG_SECRET && !value) return undefined;
        if (s.type === 'boolean') {
            if (value === 'on') return true;
            return false;
        }
        if (s.type === 'number') {
            if (!Number.isSafeInteger(parseInt(value, 10))) {
                throw new ValidationError(key);
            }
            return parseInt(value, 10);
        }
        return value;
    }
    return undefined;
}

class SystemHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        this.response.body = {
            path: [
                ['Hydro', 'homepage'],
            ],
        };
    }
}

class SystemMainHandler extends SystemHandler {
    async get() {
        this.response.redirect = '/manage/dashboard';
    }
}

class SystemCheckConnHandler extends ConnectionHandler {
    id: string;

    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        await this.check();
    }

    async check() {
        const log = (payload: any) => this.send({ type: 'log', payload });
        const warn = (payload: any) => this.send({ type: 'warn', payload });
        const error = (payload: any) => this.send({ type: 'error', payload });
        await check.start(this, log, warn, error, (id) => { this.id = id; });
    }

    async cleanup() {
        check.cancel(this.id);
    }
}

class SystemDashboardHandler extends SystemHandler {
    async get() {
        this.response.template = 'manage_dashboard.html';
        this.response.body.path.push(['manage_dashboard', null]);
    }

    async postRestart() {
        const count = system.get('server.worker');
        process.send({ event: 'restart', count });
        this.back();
    }
}

class SystemScriptHandler extends SystemHandler {
    async get() {
        this.response.template = 'manage_script.html';
        this.response.body.scripts = global.Hydro.script;
        this.response.body.path.push(['manage_script', null]);
    }

    @param('id', Types.String)
    @param('args', Types.String, true)
    async post(domainId: string, id: string, raw = '{}') {
        if (!global.Hydro.script[id]) throw new ValidationError('id');
        const args = JSON.parse(raw);
        validate(global.Hydro.script[id].validate, args);
        const rid = await record.add(domainId, -1, this.user._id, '-', id, false, { input: 'raw' });
        const report = (data) => judge.next({ domainId, rid, ...data });
        report({ message: `Running script: ${id}`, status: STATUS.STATUS_JUDGING });
        const start = new Date().getTime();
        // Maybe async?
        global.Hydro.script[id].run(args, report)
            .then((ret: any) => {
                const time = new Date().getTime() - start;
                judge.end({
                    domainId,
                    rid,
                    status: STATUS.STATUS_ACCEPTED,
                    message: inspect(ret, false, 10, true),
                    judger: 1,
                    time,
                    memory: 0,
                });
            })
            .catch((err: Error) => {
                const time = new Date().getTime() - start;
                judge.end({
                    domainId,
                    rid,
                    status: STATUS.STATUS_SYSTEM_ERROR,
                    message: `${err}\n${err.stack}`,
                    judger: 1,
                    time,
                    memory: 0,
                });
            });
        this.response.body = { rid };
        this.response.redirect = this.url('record_detail', { rid });
    }
}

class SystemSettingHandler extends SystemHandler {
    async get() {
        this.response.template = 'manage_setting.html';
        this.response.body.path.push(['manage_setting', null]);
        this.response.body.current = {};
        this.response.body.settings = setting.SYSTEM_SETTINGS;
        for (const s of this.response.body.settings) {
            // FIXME no-await-in-loop
            // eslint-disable-next-line no-await-in-loop
            this.response.body.current[s.key] = system.get(s.key);
        }
    }

    async post(args: any) {
        const tasks = [];
        for (const key in args) {
            if (typeof args[key] === 'object') {
                for (const subkey in args[key]) {
                    if (typeof set(`${key}.${subkey}`, args[key][subkey]) !== 'undefined') {
                        // @ts-ignore
                        tasks.push(system.set(`${key}.${subkey}`, set(`${key}.${subkey}`, args[key][subkey])));
                    }
                }
            } else if (typeof set(key, args[key]) !== 'undefined') {
                // @ts-ignore
                tasks.push(system.set(key, set(key, args[key])));
            }
        }
        await Promise.all(tasks);
        this.back();
    }
}

class SystemUserImportHandler extends SystemHandler {
    async get() {
        this.response.body.users = [];
        this.response.body.path.push(['manage_user_import']);
        this.response.template = 'manage_user_import.html';
    }

    @param('users', Types.String)
    @param('confirm', Types.Boolean)
    async post(domainId: string, _users: string, confirm: boolean) {
        const users = _users.split('\n');
        const udocs = [];
        const tasks = [];
        const messages = [];
        for (const i in users) {
            const u = users[i];
            const [email, username, password] = u.split(',').map((t) => t.trim());
            if (email && username && password) {
                if (!isEmail(email)) messages.push(`Line ${i + 1}: Invalid email.`);
                else if (!isUname(username)) messages.push(`Line ${i + 1}: Invalid username`);
                else if (!isPassword(password)) messages.push(`Line ${i + 1}: Invalid password`);
                else {
                    udocs.push({ email, username, password });
                    if (!confirm) tasks.push(user.create(email, username, password));
                }
            } else messages.push(`Line ${i + 1}: Input invalid.`);
        }
        messages.push(`${udocs.length} users found.`);
        await Promise.all(tasks);
        this.response.body.path.push(['manage_user_import']);
        this.response.body.users = udocs;
        this.response.body.messages = messages;
    }
}

async function apply() {
    Route('manage', '/manage', SystemMainHandler);
    Route('manage_dashboard', '/manage/dashboard', SystemDashboardHandler);
    Route('manage_script', '/manage/script', SystemScriptHandler);
    Route('manage_setting', '/manage/setting', SystemSettingHandler);
    Route('manage_user_import', '/manage/userimport', SystemUserImportHandler);
    Connection('manage_check', '/manage/check-conn', SystemCheckConnHandler);
}

global.Hydro.handler.manage = apply;
