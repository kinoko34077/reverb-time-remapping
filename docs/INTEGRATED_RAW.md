# R5a Integrated raw基盤
T3の入力配置p=e+dと、その時点のA(p)を寄与アンカーにする。renderIntegratedRaw(input,ir,clock,options)は有限Float64時計履歴（出力frameに対応するA）とミックス済みmono/stereo PCMから、配置済み寄与だけを合算する。入力とIRのサンプルレート・チャンネル契約はR2と同じ。負配置は事前取得済みPCM/時計履歴がある場合だけ扱う。
- raw参照では同一A(p)の寄与は数学的に同値なので合算してMapに保持し、入力×IRの全展開はしない。任意seek/逆行で過去の寄与を復活させるためage範囲外だけを理由に履歴を捨てない。
- 反復/往復はATFのloopSourcePosition/nextSourceSampleIndex/reflected readerを再利用。非反復の末尾の隣接サンプルは0。元座標の範囲と補間をR1の独立Float64 oracleで比較する。
- 通常時計は既存畳み込みと一致。固定rawはDCになり得るので聴取用continuousとは分離。continuousでは位相初期化が異なる寄与を同じanchorだけで群化してはならない。
- 有限PCM推定予算とgroup数・計算項数の明示上限（初期8百万項、測定で再評価）、欠落した配置時計、不正範囲/非有限値を拒否。長尺実用アルゴリズム・出力安全段・Worker/UI・continuousの受入はR5後続。同期coreは短尺の検証基盤でありメインUIから長尺呼出ししない。
