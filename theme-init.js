/* 팝업 렌더 전에 테마를 먼저 세팅해서 깜빡임을 막는다. head 에서 동기 실행되어야 한다. */
document.documentElement.dataset.theme = localStorage.getItem('rc-theme') === 'light' ? 'light' : 'dark';
