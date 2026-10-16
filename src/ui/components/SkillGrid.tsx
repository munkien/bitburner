import { SKILLS, type SkillName } from "../doc";
import { level } from "../format";

/**
 * The seven stats as proportional meters.
 *
 * Bars are scaled against the highest skill, so the panel always shows relative
 * aptitude regardless of how far the run has progressed — an absolute scale
 * would leave a fresh run with seven invisible bars.
 */
export function SkillGrid({
    skills,
    exp,
}: {
    skills: Partial<Record<SkillName, number>>;
    exp: Partial<Record<SkillName, number>>;
}) {
    const values = SKILLS.map((name) => skills[name] ?? 0);
    const peak = Math.max(1, ...values);

    return (
        <section className="panel panel--skills">
            <h2 className="panel__title">Skills</h2>
            <dl className="meters">
                {SKILLS.map((name) => {
                    const value = skills[name] ?? 0;
                    const pct = (value / peak) * 100;
                    return (
                        <div className="meter" key={name}>
                            <dt className="meter__label">{name}</dt>
                            <dd className="meter__body">
                                <div
                                    className="meter__track"
                                    role="meter"
                                    aria-valuenow={Math.floor(value)}
                                    aria-valuemin={0}
                                    aria-valuemax={Math.floor(peak)}
                                    aria-label={name}
                                >
                                    <span
                                        className="meter__fill"
                                        style={{ width: `${pct}%` }}
                                    />
                                </div>
                                <span className="meter__value">
                                    {level(value)}
                                </span>
                                <span className="meter__exp">
                                    {compactExp(exp[name])}
                                </span>
                            </dd>
                        </div>
                    );
                })}
            </dl>
        </section>
    );
}

/** Experience runs into the millions; show it compact so the column stays narrow. */
function compactExp(value: number | undefined): string {
    if (typeof value !== "number" || value < 1) return "";
    const n = Math.abs(value);
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}b xp`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m xp`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k xp`;
    return `${Math.round(n)} xp`;
}
